/**
 * Test-suite copy of the canonical coach-compliance/coach-compliance.ts,
 * kept in sync by hand exactly like every other deployed copy. No import
 * adjustment needed - this file has no internal imports.
 */
/**
 * Pure coach compliance/qualification resolution for Coaches Slice 8 (see
 * TEST-ENV.md). No Airtable/Supabase/network calls - directly unit-testable
 * against plain fixture rows, same convention as coach-rates.ts and
 * coach-availability.ts.
 *
 * Two locked product rules shape everything here:
 * - Verification ("seen by Management") and compliance status are related
 *   but separate. An attachment is optional: attachment present never means
 *   verified, attachment absent never means non-compliant.
 * - Status is DERIVED from the record's own data (Active, Expiry / Review
 *   Date, verification fields) against the organisation's requirement and
 *   today's Europe/London date. The stored Status text is not trusted, with
 *   one deliberate exception: a manually stored "Needs Review" is honoured,
 *   because it can only ever make the answer more cautious.
 */

const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export const DOCUMENT_TYPES = ["Enhanced DBS", "Safeguarding Certificate", "First Aid", "School Induction", "Other"] as const;
export const COMPLIANCE_STATUSES = ["Current", "Review Soon", "Needs Review", "Expired", "Missing"] as const;
export type ComplianceStatus = (typeof COMPLIANCE_STATUSES)[number];

export interface AirtableRecord {
  id: string;
  fields: Record<string, any>;
}

export interface Caller {
  userId: string;
  displayName: string | null;
}

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

/** Management-only predicate, kept pure so the deployed rule is directly unit-testable (same convention as Slices 6/7). */
export function isManagementCaller(caller: { role: string; active: boolean } | null): boolean {
  return !!caller && caller.active === true && caller.role === "management";
}

export function isValidRecordId(id: any): id is string {
  return RECORD_ID_RE.test(String(id ?? ""));
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

/** The only place verification fields are built. Identity and time come from the authenticated caller and the server clock - never from the request body. */
export function buildVerificationPatch(caller: Caller, now: Date): Record<string, unknown> {
  return {
    "Verified By User ID": caller.userId,
    "Verified By Name Snapshot": caller.displayName,
    "Verified At": now.toISOString(),
  };
}

export type VerifyDecision =
  | { action: "write" }
  | { action: "already_verified"; verification: { userId: string; name: string | null; at: string } }
  | { action: "reject"; code: "inactive_record" | "no_coach" | "incomplete_verification"; error: string };

/**
 * Verifying is idempotent and never rewrites an existing verification: a
 * second verify call reports the original verifier unchanged. Historical
 * (inactive) rows cannot be verified, and a half-written verification is
 * refused rather than silently overwritten (that would destroy audit data -
 * see TEST-ENV.md, reset/revoke is deliberately not built).
 */
export function decideVerify(doc: AirtableRecord): VerifyDecision {
  if (doc.fields["Active"] !== true) return { action: "reject", code: "inactive_record", error: "Only an active Coach Document can be verified - this record is inactive/historical" };
  if (linkIds(doc.fields["Coach"]).length === 0) return { action: "reject", code: "no_coach", error: "This Coach Document is not linked to a Coach" };
  const v = readVerification(doc.fields);
  if (v.state === "verified") return { action: "already_verified", verification: { userId: v.userId, name: v.name, at: v.at } };
  if (v.state === "incomplete") return { action: "reject", code: "incomplete_verification", error: `Existing verification data is incomplete and needs manual review: ${v.issue}` };
  return { action: "write" };
}

// ---------------------------------------------------------------------
// Submission - the single write path for document CONTENT, shared by
// Coaches (own records only) and Management. Verification is never part
// of a submission: it only ever happens through decideVerify/
// buildVerificationPatch, and only for Management.
// ---------------------------------------------------------------------

export type Submitter =
  | { kind: "management"; userId: string; displayName: string | null }
  | { kind: "coach"; userId: string; displayName: string | null; coachId: string };

/**
 * Who is submitting, derived only from the authenticated profile. A coach's
 * own Coaches record id comes from profiles.airtable_person_id (the same
 * mapping hub-content uses) - never from the request body. Parents,
 * inactive profiles and coaches without a valid Coaches link cannot submit.
 */
export function resolveSubmitter(caller: { role: string; active: boolean; userId: string; displayName: string | null; airtablePersonId: string | null } | null): Submitter | null {
  if (!caller || caller.active !== true) return null;
  if (caller.role === "management") return { kind: "management", userId: caller.userId, displayName: caller.displayName };
  if (caller.role === "coach" && isValidRecordId(caller.airtablePersonId)) {
    return { kind: "coach", userId: caller.userId, displayName: caller.displayName, coachId: caller.airtablePersonId };
  }
  return null;
}

export interface AttachmentInput {
  url: string;
  filename?: string;
}

export interface SubmissionInput {
  documentId?: string | null;
  coachId?: string | null;
  documentType?: string;
  issueDate?: string | null;
  expiryDate?: string | null;
  /** Replaces the attachment list. Airtable fetches each https URL itself. `[]`/null clears it. */
  attachments?: AttachmentInput[] | null;
}

const SUBMISSION_KEYS = ["documentId", "coachId", "documentType", "issueDate", "expiryDate", "attachments"];

/**
 * Allowlist, not a blocklist: anything outside SUBMISSION_KEYS is rejected
 * outright. That is what makes self-verification impossible (no Verified
 * By/At, "verified", Status or Active can ever ride along in a submission)
 * rather than merely ignored.
 */
export function parseSubmissionBody(body: any): { input: SubmissionInput } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid JSON body" };
  const unknown = Object.keys(body).filter((k) => !SUBMISSION_KEYS.includes(k));
  if (unknown.length) {
    const verificationLike = unknown.filter((k) => /verif|seen/i.test(k));
    if (verificationLike.length) return { error: `Verification cannot be supplied in a submission (${verificationLike.join(", ")}) - only Management can verify, via /verify` };
    return { error: `Unsupported field(s): ${unknown.join(", ")}. Allowed: ${SUBMISSION_KEYS.join(", ")}` };
  }
  const input: SubmissionInput = {};
  if (body.documentId !== undefined) {
    if (!isValidRecordId(body.documentId)) return { error: "documentId must be a valid Airtable record ID" };
    input.documentId = body.documentId;
  }
  if (body.coachId !== undefined) {
    if (!isValidRecordId(body.coachId)) return { error: "coachId must be a valid Airtable record ID" };
    input.coachId = body.coachId;
  }
  if (body.documentType !== undefined) {
    if (!(DOCUMENT_TYPES as readonly string[]).includes(body.documentType)) return { error: `documentType must be one of: ${DOCUMENT_TYPES.join(", ")}` };
    input.documentType = body.documentType;
  }
  for (const k of ["issueDate", "expiryDate"] as const) {
    if (body[k] === undefined) continue;
    if (body[k] !== null && !isValidIsoDate(body[k])) return { error: `${k} must be a valid YYYY-MM-DD date or null` };
    input[k] = body[k];
  }
  if (body.attachments !== undefined) {
    if (body.attachments !== null && !Array.isArray(body.attachments)) return { error: "attachments must be an array of { url, filename? } or null" };
    const list = body.attachments ?? [];
    if (list.length > 10) return { error: "At most 10 attachments" };
    for (const a of list) {
      if (!a || typeof a.url !== "string" || !/^https:\/\//.test(a.url)) return { error: "Each attachment needs an https url" };
      if (a.filename !== undefined && typeof a.filename !== "string") return { error: "attachment filename must be a string" };
    }
    input.attachments = list.map((a: any) => (a.filename ? { url: a.url, filename: a.filename } : { url: a.url }));
  }
  return { input };
}

export type SubmissionPlan =
  | { action: "create"; fields: Record<string, unknown> }
  | { action: "update"; documentId: string; patch: Record<string, unknown> }
  | { action: "supersede"; oldDocumentId: string; newFields: Record<string, unknown>; oldPatch: Record<string, unknown> }
  | { action: "unchanged"; documentId: string }
  | { action: "reject"; httpStatus: 400 | 403 | 409; code: string; error: string };

function uploadStamp(s: Submitter, now: Date): Record<string, unknown> {
  return { "Uploaded By User ID": s.userId, "Uploaded By Name Snapshot": s.displayName, "Uploaded At": now.toISOString() };
}

function datesInOrder(issue: any, expiry: any): string | null {
  if (isValidIsoDate(issue) && isValidIsoDate(expiry) && issue > expiry) return `Issue Date ${issue} cannot be after Expiry / Review Date ${expiry}`;
  return null;
}

/** New record for `coachId`. Always unverified, so it resolves to Needs Review until Management verifies it. */
export function planCreate(s: Submitter, input: SubmissionInput, coachId: string, activeSameTypeForCoach: AirtableRecord[], now: Date): SubmissionPlan {
  if (s.kind === "coach" && coachId !== s.coachId) return { action: "reject", httpStatus: 403, code: "not_own_coach", error: "A coach can only submit documents for themselves" };
  if (!input.documentType) return { action: "reject", httpStatus: 400, code: "document_type_required", error: `documentType is required to create a document (one of: ${DOCUMENT_TYPES.join(", ")})` };
  if (activeSameTypeForCoach.length) {
    return { action: "reject", httpStatus: 409, code: "active_record_exists", error: `An active ${input.documentType} record already exists (${activeSameTypeForCoach.map((d) => d.id).join(", ")}) - update it instead of creating a duplicate` };
  }
  const order = datesInOrder(input.issueDate, input.expiryDate);
  if (order) return { action: "reject", httpStatus: 400, code: "issue_date_after_expiry", error: order };
  const fields: Record<string, unknown> = {
    "Document ID": `DOC-${coachId}-${input.documentType}-${now.getTime()}`,
    "Coach": [coachId],
    "Document Type": input.documentType,
    "Active": true,
    ...uploadStamp(s, now),
  };
  if (input.issueDate != null) fields["Issue Date"] = input.issueDate;
  if (input.expiryDate != null) fields["Expiry / Review Date"] = input.expiryDate;
  if (input.attachments && input.attachments.length) fields["Attachment"] = input.attachments;
  return { action: "create", fields };
}

function carriedAttachments(existing: AirtableRecord): AttachmentInput[] {
  const att = existing.fields["Attachment"];
  if (!Array.isArray(att)) return [];
  return att.filter((a) => a && typeof a.url === "string").map((a) => (a.filename ? { url: a.url, filename: a.filename } : { url: a.url }));
}

/**
 * Update an existing ACTIVE record. Material changes are Issue Date, Expiry
 * / Review Date and any supplied attachment list (a replacement file).
 *
 * - Coach, record currently unverified   -> updated in place (still Needs Review).
 * - Coach, record verified (or half-verified) and materially changed ->
 *   SUPERSEDED: a new active, unverified record carries the new content
 *   (plus the existing attachment if none was supplied) and the old
 *   verified record becomes inactive history with its verification intact.
 *   The item therefore needs Management review again, and no audit field
 *   is ever cleared or overwritten.
 * - Management -> updated in place; an existing verification is kept, since
 *   Management is the reviewing party.
 * - Nothing actually different -> unchanged (a verified record stays verified).
 */
export function planUpdate(s: Submitter, input: SubmissionInput, existing: AirtableRecord, now: Date): SubmissionPlan {
  const f = existing.fields;
  if (s.kind === "coach" && !linkIds(f["Coach"]).includes(s.coachId)) return { action: "reject", httpStatus: 403, code: "not_own_document", error: "A coach can only update their own documents" };
  if (f["Active"] !== true) return { action: "reject", httpStatus: 409, code: "historical_record", error: "This document is inactive/historical and cannot be changed" };
  if (input.coachId !== undefined && !linkIds(f["Coach"]).includes(input.coachId!)) return { action: "reject", httpStatus: 400, code: "coach_mismatch", error: "coachId does not match this document's coach - documents cannot be moved between coaches" };
  if (input.documentType !== undefined && input.documentType !== selectName(f["Document Type"])) {
    return { action: "reject", httpStatus: 400, code: "type_change_not_allowed", error: "Document Type cannot be changed - create a new document of the other type instead" };
  }

  const changes: Record<string, unknown> = {};
  if (input.issueDate !== undefined && (input.issueDate ?? null) !== (f["Issue Date"] ?? null)) changes["Issue Date"] = input.issueDate;
  if (input.expiryDate !== undefined && (input.expiryDate ?? null) !== (f["Expiry / Review Date"] ?? null)) changes["Expiry / Review Date"] = input.expiryDate;
  const existingHasAttachment = Array.isArray(f["Attachment"]) && f["Attachment"].length > 0;
  if (input.attachments !== undefined && (input.attachments!.length > 0 || existingHasAttachment)) changes["Attachment"] = input.attachments;
  if (Object.keys(changes).length === 0) return { action: "unchanged", documentId: existing.id };

  const mergedIssue = "Issue Date" in changes ? changes["Issue Date"] : f["Issue Date"];
  const mergedExpiry = "Expiry / Review Date" in changes ? changes["Expiry / Review Date"] : f["Expiry / Review Date"];
  const order = datesInOrder(mergedIssue, mergedExpiry);
  if (order) return { action: "reject", httpStatus: 400, code: "issue_date_after_expiry", error: order };

  if (s.kind === "coach" && readVerification(f).state !== "unverified") {
    const type = selectName(f["Document Type"]);
    const coachId = s.coachId;
    const newFields: Record<string, unknown> = {
      "Document ID": `DOC-${coachId}-${type}-${now.getTime()}`,
      "Coach": [coachId],
      "Document Type": type,
      "Active": true,
      ...uploadStamp(s, now),
    };
    if (mergedIssue != null) newFields["Issue Date"] = mergedIssue;
    if (mergedExpiry != null) newFields["Expiry / Review Date"] = mergedExpiry;
    const attachments = "Attachment" in changes ? (changes["Attachment"] as AttachmentInput[] | null) : carriedAttachments(existing);
    if (attachments && attachments.length) newFields["Attachment"] = attachments;
    return { action: "supersede", oldDocumentId: existing.id, newFields, oldPatch: { "Active": false } };
  }

  return { action: "update", documentId: existing.id, patch: { ...changes, ...uploadStamp(s, now) } };
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

/** Safe, attachment-free view of a single document for write responses. */
export function documentWriteView(doc: AirtableRecord, todayIso: string): DocumentView & { documentType: string; active: boolean } {
  return { ...toView(doc, todayIso), documentType: selectName(doc.fields["Document Type"]), active: doc.fields["Active"] === true };
}
