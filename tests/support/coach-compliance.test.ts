// Unit tests for Coaches Slice 8 (coach compliance/qualification status -
// see TEST-ENV.md). Status/requirement items exercise coach-compliance.ts's
// pure resolver directly. Verification/metadata items mock global fetch
// (same convention as coach-availability.test.ts) to prove the real
// orchestrator writes exactly the server-built fields and nothing else.
import {
  COMPLIANCE_STATUSES,
  DOCUMENT_TYPES,
  buildVerificationPatch,
  isManagementCaller,
  parseSubmissionBody,
  resolveSubmitter,
  summarizeCompliance,
  ukToday,
  type AirtableRecord,
  type Submitter,
} from "./coach-compliance.ts";
import { getComplianceSummary, submitCoachDocument, verifyCoachDocument } from "./coach-compliance-orchestrator.ts";

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}

const COACH = "recCoachComply001";
const OTHER = "recCoachOther0001";
const TODAY = "2026-10-01";
const MGR = { userId: "8b3c1f4e-0000-4000-8000-00000000mgr1", displayName: "Pat Manager" };
const VERIFIED = { "Verified By User ID": "prior-manager-uuid", "Verified By Name Snapshot": "Prior Manager", "Verified At": "2026-09-01T10:00:00.000Z" };
const SECRET_ATTACHMENT = [{ id: "attSECRET0000001", url: "https://dl.airtable.com/secret-dbs-scan.pdf", filename: "secret-dbs-scan.pdf", size: 1234, type: "application/pdf" }];

function doc(id: string, type: string | null, extra: Record<string, any> = {}, o: { active?: boolean; coach?: string } = {}): AirtableRecord {
  const fields: Record<string, any> = { "Coach": [o.coach ?? COACH], "Active": o.active ?? true, ...extra };
  if (type != null) fields["Document Type"] = type;
  return { id, fields };
}

function req(id: string, type: string, lead: number | null | string = null, extra: Record<string, any> = {}): AirtableRecord {
  const fields: Record<string, any> = { "Document Type": type, "Required": true, "Active": true, ...extra };
  if (lead != null) fields["Review Lead Days"] = lead;
  return { id, fields };
}

const DBS_REQ = req("recReqDBS00000001", "Enhanced DBS", 45);
const item = (s: ReturnType<typeof summarizeCompliance>, type: string) => s.items.find((i) => i.documentType === type)!;

// --- 1. Verified, no attachment, in date -> Current ---
{
  const s = summarizeCompliance(COACH, [doc("recDocDBS00000001", "Enhanced DBS", { ...VERIFIED, "Expiry / Review Date": "2027-06-30" })], [DBS_REQ], TODAY);
  const i = item(s, "Enhanced DBS");
  ck("1. Verified Enhanced DBS with NO attachment and a 2027-06-30 review date is Current - attachment is optional", i.status === "Current" && i.record!.verified && i.record!.hasAttachment === false && i.needsAttention === false, `${i.status}/${i.reason}`);
}

// --- 2. Attachment present but not verified ---
{
  const s = summarizeCompliance(COACH, [doc("recDocDBS00000002", "Enhanced DBS", { "Attachment": SECRET_ATTACHMENT, "Expiry / Review Date": "2027-06-30", "Status": "Current" })], [DBS_REQ], TODAY);
  const i = item(s, "Enhanced DBS");
  ck("2. An attachment alone never means verified - unverified item with a file is Needs Review (not_verified), even though its stored Status says Current", i.status === "Needs Review" && i.reason === "not_verified" && i.record!.verified === false && i.record!.hasAttachment === true, `${i.status}/${i.reason}`);
}

// --- 5. Required but absent -> Missing ---
{
  const s = summarizeCompliance(COACH, [], [DBS_REQ, req("recReqFirstAid001", "First Aid")], TODAY);
  ck("5. A required document type with no record is Missing", item(s, "Enhanced DBS").status === "Missing" && item(s, "First Aid").status === "Missing" && item(s, "First Aid").needsAttention, `${item(s, "Enhanced DBS").status}/${item(s, "First Aid").status}`);
}

// --- 6-9. Expiry / Review Soon / boundary ---
{
  const at = (expiry: string, lead: number | null) =>
    item(summarizeCompliance(COACH, [doc("recDocDBSExpiry01", "Enhanced DBS", { ...VERIFIED, "Expiry / Review Date": expiry })], [req("recReqDBSLead0001", "Enhanced DBS", lead)], TODAY), "Enhanced DBS");

  const future = at("2026-11-16", 45); // 46 days away
  ck("6. Expiry beyond the Review Lead Days window (46 days away, lead 45) -> Current", future.status === "Current" && future.record!.daysUntilExpiry === 46, `${future.status}/${future.record!.daysUntilExpiry}`);

  const soon = at("2026-11-15", 45); // exactly 45 days away
  const soonInside = at("2026-10-20", 45);
  ck("7. Exactly at the configured Review Lead Days (45 days, lead 45) -> Review Soon", soon.status === "Review Soon" && soon.reason === "within_review_lead_days", `${soon.status}/${soon.record!.daysUntilExpiry}`);
  ck("7b. Well inside the window (19 days) -> Review Soon, and it raises needsAttention", soonInside.status === "Review Soon" && soonInside.needsAttention, soonInside.status);

  const noLead = at("2026-10-05", null);
  ck("7c. No Review Lead Days configured -> never Review Soon (no threshold is invented); 4 days from expiry is still Current", noLead.status === "Current", noLead.status);

  const boundaryNoLead = at(TODAY, null);
  const boundaryWithLead = at(TODAY, 45);
  ck("8. Expiry date == today: still valid through today (Current with no lead window, daysUntilExpiry 0)", boundaryNoLead.status === "Current" && boundaryNoLead.record!.daysUntilExpiry === 0, `${boundaryNoLead.status}/${boundaryNoLead.record!.daysUntilExpiry}`);
  ck("8b. ...and with a lead window it is Review Soon on its last valid day, never Expired", boundaryWithLead.status === "Review Soon", boundaryWithLead.status);

  const expired = at("2026-09-30", 45);
  ck("9. The day after the expiry date -> Expired", expired.status === "Expired" && expired.reason === "expiry_date_passed" && expired.record!.daysUntilExpiry === -1, `${expired.status}/${expired.record!.daysUntilExpiry}`);

  const expiredUnverified = item(summarizeCompliance(COACH, [doc("recDocDBSExpUnv01", "Enhanced DBS", { "Expiry / Review Date": "2026-01-01" })], [DBS_REQ], TODAY), "Enhanced DBS");
  ck("9b. Expired wins over not-verified (the more precise and severe signal)", expiredUnverified.status === "Expired", expiredUnverified.status);
}

// --- 10. Incomplete / needs manual review ---
{
  const one = (extra: Record<string, any>) => item(summarizeCompliance(COACH, [doc("recDocDBSIncomp01", "Enhanced DBS", extra)], [DBS_REQ], TODAY), "Enhanced DBS");

  const halfVerified = one({ "Verified By User ID": "someone", "Expiry / Review Date": "2027-06-30" });
  ck("10a. Verified By without Verified At is incomplete -> Needs Review, never Current", halfVerified.status === "Needs Review" && halfVerified.reason === "incomplete_verification" && !halfVerified.record!.verified, `${halfVerified.status}/${halfVerified.reason}`);

  const noExpiry = one({ ...VERIFIED });
  ck("10b. Verified but no Expiry / Review Date -> Needs Review (no expiry is ever invented)", noExpiry.status === "Needs Review" && noExpiry.reason === "missing_expiry_date", `${noExpiry.status}/${noExpiry.reason}`);

  const badOrder = one({ ...VERIFIED, "Issue Date": "2027-07-01", "Expiry / Review Date": "2027-06-30" });
  ck("10c. Issue Date after Expiry / Review Date -> Needs Review", badOrder.status === "Needs Review" && badOrder.reason === "issue_date_after_expiry", `${badOrder.status}/${badOrder.reason}`);

  const manualFlag = one({ ...VERIFIED, "Expiry / Review Date": "2027-06-30", "Status": "Needs Review" });
  ck("10d. A manually stored Status of Needs Review is honoured (it can only make the answer more cautious)", manualFlag.status === "Needs Review" && manualFlag.reason === "manual_review_flag", `${manualFlag.status}/${manualFlag.reason}`);

  const storedExpired = one({ ...VERIFIED, "Expiry / Review Date": "2027-06-30", "Status": "Expired" });
  ck("10e. Any other stored Status text is not trusted - a stale 'Expired' on an in-date verified record still resolves Current", storedExpired.status === "Current", storedExpired.status);

  const garbledDate = one({ ...VERIFIED, "Expiry / Review Date": "30/06/2027" });
  ck("10f. A malformed date value -> Needs Review", garbledDate.status === "Needs Review" && garbledDate.reason === "malformed_dates", `${garbledDate.status}/${garbledDate.reason}`);

  const unclassified = summarizeCompliance(COACH, [doc("recDocNoType00001", null, { ...VERIFIED })], [DBS_REQ], TODAY);
  ck("10g. An active document with no Document Type is surfaced as a problem and raises needsAttention", unclassified.problems.some((p) => p.recordId === "recDocNoType00001") && unclassified.needsAttention);
}

// --- 11. Inactive/historical ---
{
  const onlyOld = item(summarizeCompliance(COACH, [doc("recDocDBSOld00001", "Enhanced DBS", { ...VERIFIED, "Expiry / Review Date": "2030-01-01" }, { active: false })], [DBS_REQ], TODAY), "Enhanced DBS");
  ck("11a. An inactive (historical) record never counts as current, even when verified and in date -> Missing", onlyOld.status === "Missing" && onlyOld.historicalRecordCount === 1, `${onlyOld.status}/${onlyOld.historicalRecordCount}`);

  const replaced = item(summarizeCompliance(COACH, [
    doc("recDocDBSOld00002", "Enhanced DBS", { ...VERIFIED, "Expiry / Review Date": "2026-01-01" }, { active: false }),
    doc("recDocDBSNew00002", "Enhanced DBS", { ...VERIFIED, "Expiry / Review Date": "2029-01-01" }),
  ], [DBS_REQ], TODAY), "Enhanced DBS");
  ck("11b. A replacement record (active) is the operational record; the expired historical row is preserved and counted, not used", replaced.status === "Current" && replaced.record!.id === "recDocDBSNew00002" && replaced.historicalRecordCount === 1, `${replaced.status}/${replaced.record?.id}`);
}

// --- 12. Conflicting simultaneous current records ---
{
  const both = item(summarizeCompliance(COACH, [
    doc("recDocDBSDupA0001", "Enhanced DBS", { ...VERIFIED, "Expiry / Review Date": "2027-01-01" }),
    doc("recDocDBSDupB0001", "Enhanced DBS", { ...VERIFIED, "Expiry / Review Date": "2029-01-01" }),
  ], [DBS_REQ], TODAY), "Enhanced DBS");
  ck("12. Two active records for the same type -> Needs Review with both ids surfaced, never an arbitrary pick", both.status === "Needs Review" && both.reason === "conflicting_active_records" && both.record === null && both.conflictingRecordIds.length === 2, `${both.status}/${both.conflictingRecordIds.join(",")}`);
}

// --- 13. No cross-coach leakage ---
{
  const s = summarizeCompliance(COACH, [doc("recDocOtherDBS001", "Enhanced DBS", { ...VERIFIED, "Expiry / Review Date": "2030-01-01" }, { coach: OTHER })], [DBS_REQ], TODAY);
  ck("13a. Another coach's verified DBS never satisfies this coach's requirement -> Missing", item(s, "Enhanced DBS").status === "Missing");

  const s2 = summarizeCompliance(OTHER, [
    doc("recDocOtherDBS002", "Enhanced DBS", { ...VERIFIED, "Expiry / Review Date": "2030-01-01" }, { coach: OTHER }),
    doc("recDocMineDBS0002", "Enhanced DBS", { ...VERIFIED, "Expiry / Review Date": "2030-01-01" }),
  ], [DBS_REQ], TODAY);
  ck("13b. ...and this coach's record never creates a false duplicate for the other coach (Current, not conflicting)", item(s2, "Enhanced DBS").status === "Current" && item(s2, "Enhanced DBS").record!.id === "recDocOtherDBS002", item(s2, "Enhanced DBS").status);
}

// --- 14-15. Role predicate ---
ck("14. A Coach-role caller fails the Management-only predicate (cannot verify/update)", !isManagementCaller({ role: "coach", active: true }));
ck("15. A Parent-role caller fails the Management-only predicate (cannot verify/update)", !isManagementCaller({ role: "parent", active: true }));
ck("15b. Positive control: active Management passes; inactive Management and no caller fail", isManagementCaller({ role: "management", active: true }) && !isManagementCaller({ role: "management", active: false }) && !isManagementCaller(null));

// --- 17. Needs Attention-ready signals ---
{
  const s = summarizeCompliance(COACH, [
    doc("recDocDBSCur00001", "Enhanced DBS", { ...VERIFIED, "Expiry / Review Date": "2029-01-01" }),
    doc("recDocSafeSoon001", "Safeguarding Certificate", { ...VERIFIED, "Expiry / Review Date": "2026-10-10" }),
    doc("recDocFAExp000001", "First Aid", { ...VERIFIED, "Expiry / Review Date": "2026-09-01" }),
    doc("recDocOtherOpt001", "Other", { "Expiry / Review Date": "2020-01-01" }),
  ], [DBS_REQ, req("recReqSafe0000001", "Safeguarding Certificate", 30), req("recReqFirstAid002", "First Aid", 30), req("recReqInduct00001", "School Induction")], TODAY);
  const statuses = Object.fromEntries(s.items.map((i) => [i.documentType, i.status]));
  ck("17a. Summary exposes one clean status per required type", JSON.stringify(statuses) === JSON.stringify({ "Enhanced DBS": "Current", "Safeguarding Certificate": "Review Soon", "First Aid": "Expired", "School Induction": "Missing" }), JSON.stringify(statuses));
  ck("17b. needsAttention is true exactly for non-Current required items, and at summary level", s.items.filter((i) => i.needsAttention).map((i) => i.documentType).join(",") === "Safeguarding Certificate,First Aid,School Induction" && s.needsAttention === true);
  ck("17c. counts by status are ready for a later Needs Attention consumer", s.counts.Current === 1 && s.counts["Review Soon"] === 1 && s.counts.Expired === 1 && s.counts.Missing === 1 && s.counts["Needs Review"] === 0, JSON.stringify(s.counts));
  const other = s.otherDocuments.find((d) => d.documentType === "Other");
  ck("17d. A non-required document is reported separately and never raises needsAttention, even when expired", !!other && other.required === false && other.status === "Expired" && other.needsAttention === false, other ? `${other.status}/${other.needsAttention}` : "missing");
  ck("17e. Status vocabulary matches the real TEST Status choices", JSON.stringify(COMPLIANCE_STATUSES) === JSON.stringify(["Current", "Review Soon", "Needs Review", "Expired", "Missing"]));
  ck("17f. Document types match the real TEST Document Type choices", JSON.stringify(DOCUMENT_TYPES) === JSON.stringify(["Enhanced DBS", "Safeguarding Certificate", "First Aid", "School Induction", "Other"]));
}

// --- 18. Attachment privacy (summary) ---
{
  const s = summarizeCompliance(COACH, [doc("recDocDBSAttach01", "Enhanced DBS", { ...VERIFIED, "Expiry / Review Date": "2029-01-01", "Attachment": SECRET_ATTACHMENT })], [DBS_REQ], TODAY);
  const json = JSON.stringify(s);
  ck("18. Summary exposes only hasAttachment:true - no URL, filename, attachment id or size ever appears", item(s, "Enhanced DBS").record!.hasAttachment === true && !/secret-dbs-scan|dl\.airtable\.com|attSECRET|"url"|"filename"/.test(json), json.length.toString());
}

// --- Requirement model ---
{
  const schoolScoped = summarizeCompliance(COACH, [], [req("recReqSchool00001", "School Induction", null, { "Client / School": ["recSchool00000001"] })], TODAY);
  ck("R1. A requirement scoped to a Client / School (production shape) is not treated as organisation-wide", schoolScoped.items.length === 0 && schoolScoped.schoolScopedRequirementsNotEvaluated === 1);

  const notRequired = summarizeCompliance(COACH, [], [req("recReqNotReq00001", "First Aid", null, { "Required": false }), req("recReqInactive001", "Enhanced DBS", null, { "Active": false })], TODAY);
  ck("R2. Rows with Required unticked or Active unticked create no requirement", notRequired.items.length === 0);

  const badLead = item(summarizeCompliance(COACH, [doc("recDocDBSBadLd001", "Enhanced DBS", { ...VERIFIED, "Expiry / Review Date": "2029-01-01" })], [req("recReqBadLead0001", "Enhanced DBS", -5)], TODAY), "Enhanced DBS");
  ck("R3. A negative Review Lead Days is invalid configuration -> Needs Review, never silently Current", badLead.status === "Needs Review" && badLead.reason === "invalid_requirement_config", `${badLead.status}/${badLead.reason}`);

  const disagree = summarizeCompliance(COACH, [doc("recDocDBSDisag001", "Enhanced DBS", { ...VERIFIED, "Expiry / Review Date": "2029-01-01" })], [req("recReqDBS30000001", "Enhanced DBS", 30), req("recReqDBS60000001", "Enhanced DBS", 60)], TODAY);
  ck("R4. Two active requirement rows disagreeing on Review Lead Days -> Needs Review + problems (no 'pick the larger')", item(disagree, "Enhanced DBS").status === "Needs Review" && disagree.problems.length >= 2, `${item(disagree, "Enhanced DBS").status}/${disagree.problems.length}`);

  const agree = summarizeCompliance(COACH, [doc("recDocDBSAgree001", "Enhanced DBS", { ...VERIFIED, "Expiry / Review Date": "2029-01-01" })], [req("recReqDBSAgreeA01", "Enhanced DBS", 30), req("recReqDBSAgreeB01", "Enhanced DBS", 30)], TODAY);
  ck("R5. Duplicate requirement rows that agree are fine", item(agree, "Enhanced DBS").status === "Current" && agree.problems.length === 0, item(agree, "Enhanced DBS").status);
}

// --- Europe/London "today" ---
ck("L1. BST: 23:30Z on 30 Jun is already 1 Jul in the UK", ukToday(new Date("2026-06-30T23:30:00Z")) === "2026-07-01", ukToday(new Date("2026-06-30T23:30:00Z")));
ck("L2. GMT: 23:30Z on 31 Dec is still 31 Dec in the UK", ukToday(new Date("2026-12-31T23:30:00Z")) === "2026-12-31");
ck("L3. BST: 00:30 UK on 1 Oct (23:30Z on 30 Sep) counts as 1 Oct, so a document expiring 30 Sep is Expired from UK midnight",
  item(summarizeCompliance(COACH, [doc("recDocDBSMidnt001", "Enhanced DBS", { ...VERIFIED, "Expiry / Review Date": "2026-09-30" })], [DBS_REQ], ukToday(new Date("2026-09-30T23:30:00Z"))), "Enhanced DBS").status === "Expired");

// --- Submission: who may submit, and what a submission may carry ---
const COACH_SUBMITTER: Submitter = { kind: "coach", userId: "coach-user-uuid-0001", displayName: "Alex Coach", coachId: COACH };
const MGR_SUBMITTER: Submitter = { kind: "management", userId: MGR.userId, displayName: MGR.displayName };
{
  const coachSub = resolveSubmitter({ role: "coach", active: true, userId: "u1", displayName: "Alex", airtablePersonId: COACH });
  ck("S1. A coach submitter's own coach id comes only from their profile (airtable_person_id)", coachSub?.kind === "coach" && coachSub.coachId === COACH);
  ck("S2. Parent, inactive coach and coach without a valid Coaches link cannot submit at all",
    resolveSubmitter({ role: "parent", active: true, userId: "u2", displayName: null, airtablePersonId: "recParent00000001" }) === null &&
    resolveSubmitter({ role: "coach", active: false, userId: "u3", displayName: null, airtablePersonId: COACH }) === null &&
    resolveSubmitter({ role: "coach", active: true, userId: "u4", displayName: null, airtablePersonId: null }) === null);

  const selfVerify = parseSubmissionBody({ documentType: "Enhanced DBS", "Verified By User ID": "me", "Verified At": "2026-10-01T00:00:00Z" });
  const selfVerify2 = parseSubmissionBody({ documentType: "Enhanced DBS", verified: true });
  ck("S3. Coach self-verification is impossible: any verification field in a submission is rejected outright, not ignored", "error" in selfVerify && /only Management can verify/.test(selfVerify.error) && "error" in selfVerify2, "error" in selfVerify ? selfVerify.error : "accepted");
  const sneaky = parseSubmissionBody({ documentType: "Enhanced DBS", Status: "Current", Active: false });
  ck("S4. Status/Active (or any other non-allowlisted field) cannot be set through a submission", "error" in sneaky, "error" in sneaky ? sneaky.error : "accepted");
  ck("S5. Submission rejects an impossible date, a non-https attachment URL and an unknown document type",
    "error" in parseSubmissionBody({ expiryDate: "2027-02-30" }) && "error" in parseSubmissionBody({ attachments: [{ url: "http://insecure/x.pdf" }] }) && "error" in parseSubmissionBody({ documentType: "Passport" }));
  const ok = parseSubmissionBody({ documentType: "First Aid", expiryDate: "2028-01-31", attachments: [{ url: "https://files.example/fa.pdf", filename: "fa.pdf" }] });
  ck("S6. A well-formed submission parses", "input" in ok && ok.input.attachments!.length === 1);
}

// --- Orchestrator (mocked Airtable) ---
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeStore() {
  return {
    coaches: new Set([COACH, OTHER]),
    documents: new Map<string, Record<string, any>>(),
    requirements: [] as AirtableRecord[],
    patches: [] as Array<{ id: string; fields: Record<string, any> }>,
    creates: [] as Array<Record<string, any>>,
    nextId: 1,
  };
}

/** Mimics Airtable storing an attachment: it re-hosts the file, so the stored object gains an id/size and a new URL. */
function storeAttachments(fields: Record<string, any>) {
  if (Array.isArray(fields["Attachment"])) {
    fields["Attachment"] = fields["Attachment"].map((a: any, i: number) => ({ id: `attStored${i}`, url: a.url, filename: a.filename ?? "file", size: 10 }));
  }
  return fields;
}

function installMockFetch(store: ReturnType<typeof makeStore>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, opts: any = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    const coachMatch = u.match(/\/Coaches\/(rec[A-Za-z0-9]+)$/);
    if (coachMatch && method === "GET") return store.coaches.has(coachMatch[1]) ? jsonResponse({ id: coachMatch[1], fields: {} }) : jsonResponse({ error: "NOT_FOUND" }, 404);
    const docMatch = u.match(/\/Coach%20Documents\/(rec[A-Za-z0-9]+)$/);
    if (docMatch && method === "GET") {
      const f = store.documents.get(docMatch[1]);
      return f ? jsonResponse({ id: docMatch[1], fields: f }) : jsonResponse({ error: "NOT_FOUND" }, 404);
    }
    if (docMatch && method === "PATCH") {
      const body = JSON.parse(opts.body);
      store.patches.push({ id: docMatch[1], fields: body.fields });
      const merged = { ...(store.documents.get(docMatch[1]) || {}), ...body.fields };
      store.documents.set(docMatch[1], merged);
      return jsonResponse({ id: docMatch[1], fields: merged });
    }
    if (/\/Coach%20Documents$/.test(u) && method === "POST") {
      const fields = storeAttachments({ ...JSON.parse(opts.body).records[0].fields });
      store.creates.push(fields);
      const id = `recDocCreated${String(store.nextId++).padStart(4, "0")}`;
      store.documents.set(id, fields);
      return jsonResponse({ records: [{ id, fields }] });
    }
    if (/\/Coach%20Documents(\?.*)?$/.test(u) && method === "GET") return jsonResponse({ records: [...store.documents.entries()].map(([id, fields]) => ({ id, fields })) });
    if (/\/Coach%20Document%20Requirements(\?.*)?$/.test(u) && method === "GET") return jsonResponse({ records: store.requirements });
    throw new Error(`Unexpected fetch in coach-compliance test: ${method} ${u}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

const AIRTABLE = { baseId: "appFAKE00000000AA", token: "fake" };
const NOW = new Date("2026-10-01T09:15:00.000Z");

async function testOrchestrator() {
  const store = makeStore();
  store.requirements = [DBS_REQ];
  store.documents.set("recDocVerifyMe001", { "Coach": [COACH], "Document Type": "Enhanced DBS", "Active": true, "Expiry / Review Date": "2027-06-30" });
  store.documents.set("recDocAttachUnv01", { "Coach": [COACH], "Document Type": "First Aid", "Active": true, "Attachment": SECRET_ATTACHMENT, "Expiry / Review Date": "2027-06-30" });
  store.documents.set("recDocHistoric001", { "Coach": [COACH], "Document Type": "Enhanced DBS", "Active": false, "Expiry / Review Date": "2025-01-01" });
  store.documents.set("recDocHalfVer0001", { "Coach": [COACH], "Document Type": "Safeguarding Certificate", "Active": true, "Verified By User ID": "someone" });
  const restore = installMockFetch(store);
  try {
    const before = await getComplianceSummary({ airtable: AIRTABLE }, COACH, NOW);
    ck("O1. Before verification the unverified DBS (no attachment) is Needs Review", before.status === "ok" && before.summary.items[0].status === "Needs Review" && before.summary.items[0].reason === "not_verified");

    const v = await verifyCoachDocument({ airtable: AIRTABLE }, "recDocVerifyMe001", MGR, NOW);
    const patch = store.patches[0];
    ck("16. Management can verify a document that has NO attachment", v.status === "verified" && v.document.verified === true && v.document.hasAttachment === false, v.status);
    ck("3. Verified By comes from the authenticated Management caller (user id + name snapshot)", patch?.fields["Verified By User ID"] === MGR.userId && patch?.fields["Verified By Name Snapshot"] === MGR.displayName, JSON.stringify(patch?.fields));
    ck("4. Verified At is the server's own clock, not a client value", patch?.fields["Verified At"] === NOW.toISOString(), patch?.fields["Verified At"]);
    ck("4b. The verify write touches ONLY the three verification fields - never Attachment, Status, dates or Notes", JSON.stringify(Object.keys(patch?.fields || {}).sort()) === JSON.stringify(["Verified At", "Verified By Name Snapshot", "Verified By User ID"]));
    ck("4c. buildVerificationPatch has no input for a client-supplied identity or time at all (signature is caller + server now only)", buildVerificationPatch.length === 2);

    const after = await getComplianceSummary({ airtable: AIRTABLE }, COACH, NOW);
    ck("16b. ...after which the summary shows the DBS as verified and Current", after.status === "ok" && after.summary.items[0].status === "Current" && after.summary.items[0].record!.verifiedBy!.userId === MGR.userId);

    const again = await verifyCoachDocument({ airtable: AIRTABLE }, "recDocVerifyMe001", { userId: "second-manager", displayName: "Someone Else" }, new Date("2026-10-02T09:00:00Z"));
    ck("V1. Re-verifying is idempotent: reports already_verified and never overwrites the original verifier or time", again.status === "already_verified" && store.patches.length === 1 && again.document.verifiedBy!.userId === MGR.userId && again.document.verifiedAt === NOW.toISOString(), again.status);

    const unv = await verifyCoachDocument({ airtable: AIRTABLE }, "recDocAttachUnv01", MGR, NOW);
    ck("18b. The verify response for a document WITH an attachment still exposes only hasAttachment:true", unv.status === "verified" && unv.document.hasAttachment === true && !/secret-dbs-scan|dl\.airtable\.com|attSECRET/.test(JSON.stringify(unv)));

    const hist = await verifyCoachDocument({ airtable: AIRTABLE }, "recDocHistoric001", MGR, NOW);
    ck("V2. An inactive/historical document cannot be verified", hist.status === "rejected" && hist.code === "inactive_record", hist.status);

    const half = await verifyCoachDocument({ airtable: AIRTABLE }, "recDocHalfVer0001", MGR, NOW);
    ck("V3. A half-written existing verification is refused, not silently overwritten", half.status === "rejected" && half.code === "incomplete_verification", half.status);

    const missing = await verifyCoachDocument({ airtable: AIRTABLE }, "recDocDoesNotExst", MGR, NOW);
    ck("V4. Unknown document id -> document_not_found", missing.status === "document_not_found");

    const noCoach = await getComplianceSummary({ airtable: AIRTABLE }, "recCoachMissing01", NOW);
    ck("O2. Unknown coach id -> coach_not_found, not an empty 'all Missing' summary", noCoach.status === "coach_not_found");

    const otherSummary = await getComplianceSummary({ airtable: AIRTABLE }, OTHER, NOW);
    ck("13c. End to end: the other coach's summary never includes this coach's (now verified) DBS", otherSummary.status === "ok" && otherSummary.summary.items[0].status === "Missing");
  } finally {
    restore();
  }
}

const NOW2 = new Date("2026-10-02T11:00:00.000Z");
const verificationKeys = (fields: Record<string, any>) => Object.keys(fields).filter((k) => /verif/i.test(k));

async function testSubmissions() {
  const store = makeStore();
  store.requirements = [DBS_REQ, req("recReqFirstAid003", "First Aid", 30)];
  store.documents.set("recDocOtherCoach1", { "Coach": [OTHER], "Document Type": "Enhanced DBS", "Active": true, "Expiry / Review Date": "2028-01-01" });
  const restore = installMockFetch(store);
  try {
    // --- Coach-own submission ---
    const created = await submitCoachDocument({ airtable: AIRTABLE }, COACH_SUBMITTER, { documentType: "Enhanced DBS", expiryDate: "2027-06-30" }, NOW);
    const cf = store.creates[0] || {};
    ck("C1. Coach can create their OWN compliance item (linked to their own coach id from the profile)", created.status === "created" && JSON.stringify(cf["Coach"]) === JSON.stringify([COACH]) && cf["Active"] === true, created.status);
    ck("C1b. ...with Uploaded By/At stamped from the authenticated coach and server clock", cf["Uploaded By User ID"] === COACH_SUBMITTER.userId && cf["Uploaded At"] === NOW.toISOString());
    ck("C1c. ...and a coach submission never writes any verification field", verificationKeys(cf).length === 0, JSON.stringify(verificationKeys(cf)));
    const s1 = await getComplianceSummary({ airtable: AIRTABLE }, COACH, NOW);
    const dbs1 = s1.status === "ok" ? s1.summary.items.find((i) => i.documentType === "Enhanced DBS")! : null;
    ck("C1d. A new coach submission resolves to Needs Review (not_verified) until Management checks it", dbs1?.status === "Needs Review" && dbs1?.reason === "not_verified", `${dbs1?.status}/${dbs1?.reason}`);
    const newId = created.status === "created" ? created.document.id : "";

    // --- Cross-coach denial ---
    const createsBefore = store.creates.length, patchesBefore = store.patches.length;
    const forOther = await submitCoachDocument({ airtable: AIRTABLE }, COACH_SUBMITTER, { coachId: OTHER, documentType: "First Aid" }, NOW);
    ck("C2. A coach cannot create a document for another coach -> 403 not_own_coach, nothing written", forOther.status === "rejected" && forOther.httpStatus === 403 && forOther.code === "not_own_coach" && store.creates.length === createsBefore, forOther.status);
    const editOther = await submitCoachDocument({ airtable: AIRTABLE }, COACH_SUBMITTER, { documentId: "recDocOtherCoach1", expiryDate: "2030-01-01" }, NOW);
    ck("C3. A coach can never edit another coach's record -> 403 not_own_document, nothing written", editOther.status === "rejected" && editOther.httpStatus === 403 && editOther.code === "not_own_document" && store.patches.length === patchesBefore, editOther.status);
    ck("C3b. ...and the other coach's record is untouched", store.documents.get("recDocOtherCoach1")!["Expiry / Review Date"] === "2028-01-01");

    // --- Management verification ---
    const v = await verifyCoachDocument({ airtable: AIRTABLE }, newId, MGR, NOW);
    ck("C4. Management verifies the coach's submission (identity + server time recorded)", v.status === "verified" && store.documents.get(newId)!["Verified By User ID"] === MGR.userId && store.documents.get(newId)!["Verified At"] === NOW.toISOString());
    const s2 = await getComplianceSummary({ airtable: AIRTABLE }, COACH, NOW);
    ck("C4b. ...after which the item is Current", s2.status === "ok" && s2.summary.items.find((i) => i.documentType === "Enhanced DBS")!.status === "Current");

    // --- No-op coach edit keeps verification ---
    const createsBeforeNoop = store.creates.length, patchesBeforeNoop = store.patches.length;
    const noop = await submitCoachDocument({ airtable: AIRTABLE }, COACH_SUBMITTER, { documentId: newId, expiryDate: "2027-06-30" }, NOW2);
    ck("C5. A coach re-submitting identical values changes nothing - no write, still verified", noop.status === "unchanged" && store.creates.length === createsBeforeNoop && store.patches.length === patchesBeforeNoop && noop.document.verified === true, noop.status);

    // --- Re-review after a material coach edit ---
    store.documents.get(newId)!["Attachment"] = [{ id: "attOrig000000001", url: "https://dl.airtable.com/original-dbs.pdf", filename: "original-dbs.pdf", size: 5 }];
    const edit = await submitCoachDocument({ airtable: AIRTABLE }, COACH_SUBMITTER, { documentId: newId, expiryDate: "2029-06-30" }, NOW2);
    const oldRec = store.documents.get(newId)!;
    const newRecId = edit.status === "superseded" ? edit.document.id : "";
    const newRec = store.documents.get(newRecId) || {};
    ck("C6. A material coach change (new expiry) to a VERIFIED item supersedes it rather than silently staying verified", edit.status === "superseded" && edit.supersededDocumentId === newId && edit.document.verified === false, edit.status);
    ck("C6b. ...the new version carries the change, the coach's upload stamp, the existing attachment - and no verification", newRec["Expiry / Review Date"] === "2029-06-30" && newRec["Uploaded By User ID"] === COACH_SUBMITTER.userId && newRec["Uploaded At"] === NOW2.toISOString() && Array.isArray(newRec["Attachment"]) && newRec["Attachment"][0].url === "https://dl.airtable.com/original-dbs.pdf" && verificationKeys(newRec).length === 0);
    ck("C6c. ...the old verified record becomes inactive history with its verification preserved (no audit field cleared)", oldRec["Active"] === false && oldRec["Verified By User ID"] === MGR.userId && oldRec["Verified At"] === NOW.toISOString() && oldRec["Expiry / Review Date"] === "2027-06-30");
    const s3 = await getComplianceSummary({ airtable: AIRTABLE }, COACH, NOW2);
    const dbs3 = s3.status === "ok" ? s3.summary.items.find((i) => i.documentType === "Enhanced DBS")! : null;
    ck("C6d. ...so the compliance item requires Management review again (Needs Review / not_verified, 1 historical row)", dbs3?.status === "Needs Review" && dbs3?.reason === "not_verified" && dbs3?.record?.id === newRecId && dbs3?.historicalRecordCount === 1, `${dbs3?.status}/${dbs3?.reason}`);
    ck("C6e. The supersede response exposes no attachment URL/filename", !/original-dbs|dl\.airtable\.com/.test(JSON.stringify(edit)));

    const reverify = await verifyCoachDocument({ airtable: AIRTABLE }, newRecId, MGR, NOW2);
    ck("C6f. Management re-verifies the new version and the item is Current again", reverify.status === "verified" && (await getComplianceSummary({ airtable: AIRTABLE }, COACH, NOW2) as any).summary.items.find((i: any) => i.documentType === "Enhanced DBS").status === "Current");

    const replaced = await submitCoachDocument({ airtable: AIRTABLE }, COACH_SUBMITTER, { documentId: newRecId, attachments: [{ url: "https://files.example/renewed-dbs.pdf", filename: "renewed-dbs.pdf" }] }, NOW2);
    const replacedRec = replaced.status === "superseded" ? store.documents.get(replaced.document.id)! : {};
    ck("C7. A replacement attachment from the coach is also material -> superseded, unverified, new file on the new version only", replaced.status === "superseded" && replacedRec["Attachment"]?.[0]?.url === "https://files.example/renewed-dbs.pdf" && store.documents.get(newRecId)!["Active"] === false, replaced.status);

    // --- Coach edit on an unverified record: in place ---
    const fa = await submitCoachDocument({ airtable: AIRTABLE }, COACH_SUBMITTER, { documentType: "First Aid", expiryDate: "2027-01-01" }, NOW);
    const faId = fa.status === "created" ? fa.document.id : "";
    const createsBeforeFa = store.creates.length;
    const faEdit = await submitCoachDocument({ airtable: AIRTABLE }, COACH_SUBMITTER, { documentId: faId, expiryDate: "2027-02-01" }, NOW2);
    ck("C8. A coach editing their own still-unverified item updates it in place (no new version needed)", faEdit.status === "updated" && store.creates.length === createsBeforeFa && store.documents.get(faId)!["Expiry / Review Date"] === "2027-02-01", faEdit.status);

    // --- Management submission ---
    await verifyCoachDocument({ airtable: AIRTABLE }, faId, MGR, NOW2);
    const mgrEdit = await submitCoachDocument({ airtable: AIRTABLE }, MGR_SUBMITTER, { documentId: faId, expiryDate: "2027-03-01" }, NOW2);
    ck("C9. Management can update the same data directly; being the reviewing party, its edit keeps the verification", mgrEdit.status === "updated" && mgrEdit.document.verified === true && store.documents.get(faId)!["Expiry / Review Date"] === "2027-03-01", mgrEdit.status);

    const mgrCreate = await submitCoachDocument({ airtable: AIRTABLE }, MGR_SUBMITTER, { coachId: OTHER, documentType: "First Aid", expiryDate: "2028-05-05" }, NOW2);
    ck("C10. Management can create a document for any coach; it is unverified until Management marks it Seen", mgrCreate.status === "created" && mgrCreate.document.verified === false && store.documents.get(mgrCreate.status === "created" ? mgrCreate.document.id : "")!["Uploaded By User ID"] === MGR.userId, mgrCreate.status);
    const mgrNoCoach = await submitCoachDocument({ airtable: AIRTABLE }, MGR_SUBMITTER, { documentType: "First Aid" }, NOW2);
    ck("C10b. Management create without coachId is rejected", mgrNoCoach.status === "rejected" && mgrNoCoach.code === "coach_required");

    // --- Guard rails ---
    const dup = await submitCoachDocument({ airtable: AIRTABLE }, COACH_SUBMITTER, { documentType: "First Aid", expiryDate: "2029-01-01" }, NOW2);
    ck("C11. Creating a second active record of the same type is refused (update instead) - no accidental duplicates", dup.status === "rejected" && dup.httpStatus === 409 && dup.code === "active_record_exists", dup.status);
    const hist = await submitCoachDocument({ airtable: AIRTABLE }, COACH_SUBMITTER, { documentId: newId, expiryDate: "2031-01-01" }, NOW2);
    ck("C12. Historical (inactive) records can never be edited - history is preserved", hist.status === "rejected" && hist.code === "historical_record", hist.status);
    const typeChange = await submitCoachDocument({ airtable: AIRTABLE }, COACH_SUBMITTER, { documentId: faId, documentType: "Enhanced DBS" }, NOW2);
    ck("C13. Document Type cannot be changed on an existing record", typeChange.status === "rejected" && typeChange.code === "type_change_not_allowed", typeChange.status);
    const badDates = await submitCoachDocument({ airtable: AIRTABLE }, COACH_SUBMITTER, { documentId: faId, issueDate: "2030-01-01" }, NOW2);
    ck("C14. An Issue Date after the (merged) expiry is rejected before any write", badDates.status === "rejected" && badDates.code === "issue_date_after_expiry", badDates.status);
  } finally {
    restore();
  }
}

async function testSupersedePartialFailure() {
  const store = makeStore();
  store.requirements = [DBS_REQ];
  store.documents.set("recDocVerifiedX01", { "Coach": [COACH], "Document Type": "Enhanced DBS", "Active": true, "Expiry / Review Date": "2027-06-30", ...VERIFIED });
  const restore = installMockFetch(store);
  const inner = globalThis.fetch;
  globalThis.fetch = (async (url: any, opts: any = {}) => {
    if (String(url).endsWith("/recDocVerifiedX01") && (opts.method || "GET").toUpperCase() === "PATCH") return jsonResponse({ error: "simulated outage" }, 500);
    return inner(url, opts);
  }) as typeof fetch;
  let threw = false;
  try {
    await submitCoachDocument({ airtable: AIRTABLE }, COACH_SUBMITTER, { documentId: "recDocVerifiedX01", expiryDate: "2029-06-30" }, NOW);
  } catch {
    threw = true;
  }
  const s = await getComplianceSummary({ airtable: AIRTABLE }, COACH, NOW);
  const dbs = s.status === "ok" ? s.summary.items[0] : null;
  ck("C15. If retiring the old version fails after the new one is created, the item fails SAFE: Needs Review (two active records), never Current", threw && dbs?.status === "Needs Review" && dbs?.reason === "conflicting_active_records", `${threw}/${dbs?.status}/${dbs?.reason}`);
  globalThis.fetch = inner;
  restore();
}

async function main() {
  await testOrchestrator();
  await testSubmissions();
  await testSupersedePartialFailure();
  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
  console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} passing`);
  process.exit(failed ? 1 : 0);
}

main();
