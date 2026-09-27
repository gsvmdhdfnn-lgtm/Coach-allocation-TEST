/**
 * Composition layer for Coaches Slice 8 (see TEST-ENV.md). Sequences the
 * Airtable reads/writes around the pure decisions in coach-compliance.ts;
 * no compliance, ownership or verification rule is decided here.
 */
import {
  buildVerificationPatch,
  decideVerify,
  documentWriteView,
  isValidRecordId,
  planCreate,
  planUpdate,
  summarizeCompliance,
  ukToday,
  type Caller,
  type ComplianceSummary,
  type Submitter,
  type SubmissionInput,
} from "./coach-compliance.ts";
import {
  type AirtableConfig,
  createCoachDocument,
  fetchCoachById,
  fetchCoachDocumentById,
  fetchCoachDocumentsForCoach,
  fetchDocumentRequirements,
  updateCoachDocument,
} from "./repository.ts";

type DocumentWriteView = ReturnType<typeof documentWriteView>;

export type SummaryResult =
  | { status: "validation_error"; error: string }
  | { status: "coach_not_found" }
  | { status: "ok"; summary: ComplianceSummary };

export async function getComplianceSummary(deps: { airtable: AirtableConfig }, coachId: string | null, now: Date = new Date()): Promise<SummaryResult> {
  if (!isValidRecordId(coachId)) return { status: "validation_error", error: "coachId is required and must be a valid Airtable record ID" };
  const coach = await fetchCoachById(deps.airtable, coachId);
  if (!coach) return { status: "coach_not_found" };
  const [documents, requirements] = await Promise.all([
    fetchCoachDocumentsForCoach(deps.airtable, coachId),
    fetchDocumentRequirements(deps.airtable),
  ]);
  return { status: "ok", summary: summarizeCompliance(coachId, documents, requirements, ukToday(now)) };
}

export type VerifyResult =
  | { status: "validation_error"; error: string }
  | { status: "document_not_found" }
  | { status: "rejected"; code: string; error: string }
  | { status: "already_verified"; document: DocumentWriteView }
  | { status: "verified"; document: DocumentWriteView };

/** `caller` must be the authenticated Management identity resolved server-side - it is the only source of Verified By. */
export async function verifyCoachDocument(deps: { airtable: AirtableConfig }, documentId: string | null, caller: Caller, now: Date = new Date()): Promise<VerifyResult> {
  if (!isValidRecordId(documentId)) return { status: "validation_error", error: "documentId is required and must be a valid Airtable record ID" };
  const doc = await fetchCoachDocumentById(deps.airtable, documentId);
  if (!doc) return { status: "document_not_found" };
  const today = ukToday(now);
  const decision = decideVerify(doc);
  if (decision.action === "reject") return { status: "rejected", code: decision.code, error: decision.error };
  if (decision.action === "already_verified") return { status: "already_verified", document: documentWriteView(doc, today) };
  const updated = await updateCoachDocument(deps.airtable, documentId, buildVerificationPatch(caller, now));
  return { status: "verified", document: documentWriteView(updated, today) };
}

export type SubmitResult =
  | { status: "rejected"; httpStatus: 400 | 403 | 404 | 409; code: string; error: string }
  | { status: "created"; document: DocumentWriteView }
  | { status: "updated"; document: DocumentWriteView }
  | { status: "unchanged"; document: DocumentWriteView }
  | { status: "superseded"; document: DocumentWriteView; supersededDocumentId: string };

/**
 * The one content write path for both Coaches and Management. With a
 * documentId it updates that record; without one it creates a new record
 * for the submitter's own coach (Coach) or the given coachId (Management).
 */
export async function submitCoachDocument(deps: { airtable: AirtableConfig }, submitter: Submitter, input: SubmissionInput, now: Date = new Date()): Promise<SubmitResult> {
  const today = ukToday(now);

  if (input.documentId) {
    const existing = await fetchCoachDocumentById(deps.airtable, input.documentId);
    if (!existing) return { status: "rejected", httpStatus: 404, code: "document_not_found", error: `No Coach Document found for id ${input.documentId}` };
    const plan = planUpdate(submitter, input, existing, now);
    switch (plan.action) {
      case "reject":
        return { status: "rejected", httpStatus: plan.httpStatus, code: plan.code, error: plan.error };
      case "unchanged":
        return { status: "unchanged", document: documentWriteView(existing, today) };
      case "update": {
        const updated = await updateCoachDocument(deps.airtable, plan.documentId, plan.patch);
        return { status: "updated", document: documentWriteView(updated, today) };
      }
      case "supersede": {
        // New version first, then retire the old one. If the second step
        // fails, both stay active - which the resolver already reports as
        // Needs Review (conflicting_active_records), never as Current.
        const created = await createCoachDocument(deps.airtable, plan.newFields);
        await updateCoachDocument(deps.airtable, plan.oldDocumentId, plan.oldPatch);
        return { status: "superseded", document: documentWriteView(created, today), supersededDocumentId: plan.oldDocumentId };
      }
      default:
        return { status: "rejected", httpStatus: 400, code: "unsupported", error: "Unsupported submission" };
    }
  }

  const coachId = submitter.kind === "coach" ? input.coachId ?? submitter.coachId : input.coachId;
  if (!coachId) return { status: "rejected", httpStatus: 400, code: "coach_required", error: "coachId is required when Management creates a document" };
  if (submitter.kind === "coach" && coachId !== submitter.coachId) {
    return { status: "rejected", httpStatus: 403, code: "not_own_coach", error: "A coach can only submit documents for themselves" };
  }
  const coach = await fetchCoachById(deps.airtable, coachId);
  if (!coach) return { status: "rejected", httpStatus: 404, code: "coach_not_found", error: `No Coach found for id ${coachId}` };
  const activeSameType = input.documentType
    ? (await fetchCoachDocumentsForCoach(deps.airtable, coachId)).filter((d) => d.fields["Active"] === true && d.fields["Document Type"] === input.documentType)
    : [];
  const plan = planCreate(submitter, input, coachId, activeSameType, now);
  if (plan.action === "reject") return { status: "rejected", httpStatus: plan.httpStatus, code: plan.code, error: plan.error };
  if (plan.action !== "create") return { status: "rejected", httpStatus: 400, code: "unsupported", error: "Unsupported submission" };
  const created = await createCoachDocument(deps.airtable, plan.fields);
  return { status: "created", document: documentWriteView(created, today) };
}
