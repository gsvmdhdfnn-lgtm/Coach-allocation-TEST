/**
 * Finance invoice issue + credit notes + corrections - orchestration
 * (Finance Foundation F6; see TEST-ENV.md "Finance Foundation - F6"). Every
 * route authorises through F1's authorizeFinance() first - View reads,
 * Manage writes; no new auth.
 *
 * Reads (View) come ONLY from the stored, immutable invoice / line / credit
 * note rows - never a re-run of F4, never today's terms or client details.
 *
 * Writes (Manage) follow the F3-F5 write discipline exactly:
 *   1. authorise (manage)
 *   2. the per-organisation Finance write lock - the SAME lock F3 terms,
 *      F4 overrides and F5 drafts take, so an invoice is never issued while
 *      the draft, its claims or the billing it rests on are changing; two
 *      issue requests for one draft (or two drafts claiming one
 *      occurrence) can never both succeed                  -> 409 busy
 *      Issue ALSO takes the organisation's Finance Settings lock (the one
 *      POST /settings takes), so the Settings it reads - issuer details and
 *      the official numbering, including the Hub's next invoice number -
 *      cannot change underneath it, and two issues can never take the same
 *      Hub number                                          -> 409 finance_settings_busy
 *   3. load everything UNDER the lock and re-check every precondition
 *      (issue: the F5 review is recomputed now)            -> 400 / 404 / 409, nothing written
 *   4. the Airtable writes, each registered with its undo
 *   5. the audit events, in ONE insert
 *   Failure in 4 or 5 undoes this request's writes (the invoice, its lines,
 *   the draft stamp and the Hub next-number advance go together or not at
 *   all) and returns 503; if the undo fails the caller gets 500 (never
 *   "success").
 *   6. release the locks (always)
 */
import type { FinanceCaller, OrganisationContext } from "./finance-access.ts";
import { authorizeFinance } from "./orchestrator.ts";
import { todayIn } from "./finance-commercial.ts";
import type { Row } from "./finance-commercial-mapping.ts";
import { acquireWriteLock, insertAuditEvents, releaseWriteLock } from "./finance-commercial-repository.ts";
import { FIELD_NAMES as SETTINGS_FIELDS, SETTINGS_TABLE } from "./finance-settings.ts";
import { acquireSettingsLock, releaseSettingsLock } from "./finance-settings-repository.ts";
import { type Draft, type Line, DRAFT_EVENTS, ENTITY_DRAFT, auditDraft, auditLine, classifyWork, lineFromResolution, publicDraft, reviewDraft, totalsOf } from "./finance-invoicing.ts";
import { formatMinor } from "./finance-money.ts";
import { INVOICING_TABLES, buildDrafts, draftFields, draftRestoreFields, lineCreateFields } from "./finance-invoicing-mapping.ts";
import { type ClientWork, type InvoicingDeps, DraftTxn, draftBody, loadClientWork, loadDraft, uniqueIds } from "./finance-invoicing-orchestrator.ts";
import {
  type CreditNote,
  type Invoice,
  type InvoiceLine,
  ENTITY_CREDIT_NOTE,
  ENTITY_INVOICE,
  ISSUE_CONTRACT,
  ISSUE_EVENTS,
  auditCreditNote,
  auditInvoice,
  auditInvoiceLine,
  creditState,
  invoiceHistory,
  invoiceNumberPlan,
  issueAuditEvent,
  issueGate,
  newIssueId,
  planCreditNote,
  planIssue,
  publicCreditNote,
  publicInvoice,
  publicInvoiceLine,
} from "./finance-issue.ts";
import { type StoredInvoice, ISSUE_TABLES, buildCreditNotes, buildInvoiceLines, buildInvoices, creditNoteCreateFields, invoiceCreateFields, invoiceLineCreateFields, invoiceMatchesLines, invoiceStateFields } from "./finance-issue-mapping.ts";
import {
  findCreditNoteRows,
  findInvoiceRows,
  listCreditNoteRowsByClient,
  listCreditNoteRowsForInvoice,
  listDraftRowsByCorrection,
  listDraftRowsReplacing,
  listInvoiceLineRows,
  listInvoiceRowsByClient,
  listInvoiceRowsByCorrection,
  listInvoiceRowsByHubNumber,
  listInvoiceRowsBySourceDraft,
  listInvoiceRowsReplacing,
} from "./finance-issue-repository.ts";

export type IssueDeps = InvoicingDeps;

export type Fail = { status: "error"; httpStatus: 400 | 403 | 404 | 409 | 500 | 503; code: string; error: string; fields?: Record<string, string> };
export type Ok = { status: "ok"; httpStatus: 200 | 201; body: Record<string, unknown> };
const fail = (httpStatus: Fail["httpStatus"], code: string, error: string, fields?: Record<string, string>): Fail => ({ status: "error", httpStatus, code, error, ...(fields ? { fields } : {}) });

const now = (deps: IssueDeps) => (deps.clock ?? (() => new Date()))();
const hex = (deps: IssueDeps) => (deps.randomHex ?? (() => crypto.randomUUID()))();
const orgBody = (o: OrganisationContext) => ({ organisationId: o.organisationId, name: o.name });
const lockKey = (o: OrganisationContext) => `commercial:${o.organisationId}`;
const unavailable = () => fail(503, "finance_invoices_unavailable", "Invoices could not be loaded just now - try again");

async function guarded<T>(read: () => Promise<T>): Promise<T | Fail> {
  try {
    return await read();
  } catch (e) {
    console.error(e);
    return unavailable();
  }
}
const isFail = (x: unknown): x is Fail => !!x && typeof x === "object" && (x as any).status === "error";

function oneInvoice(rows: Row[], orgRec: string, invoiceId: string): StoredInvoice | Fail {
  const b = buildInvoices(rows, orgRec);
  if (!b.ok) return fail(409, "invoice_data_invalid", b.error);
  if (b.invoices.length === 0) return fail(404, "invoice_not_found", `No invoice ${invoiceId} in your organisation`);
  if (b.invoices.length > 1) return fail(409, "invoice_ambiguous", "More than one invoice has this id - the data must be corrected first");
  return b.invoices[0];
}

type LoadedInvoice = { invoice: StoredInvoice; lines: InvoiceLine[]; notes: CreditNote[] };

/** An invoice with its lines and credit notes (3 reads), validated against each other. */
async function loadInvoice(deps: IssueDeps, org: OrganisationContext, invoiceId: string): Promise<LoadedInvoice | Fail> {
  const r = await guarded(() => Promise.all([findInvoiceRows(deps.airtable, org.recordId, invoiceId), listInvoiceLineRows(deps.airtable, org.recordId, invoiceId), listCreditNoteRowsForInvoice(deps.airtable, org.recordId, invoiceId)]));
  if (isFail(r)) return r;
  const [invRows, lineRows, noteRows] = r;
  const inv = oneInvoice(invRows, org.recordId, invoiceId);
  if (isFail(inv)) return inv;
  const ls = buildInvoiceLines(lineRows, org.recordId);
  if (!ls.ok) return fail(409, "invoice_data_invalid", ls.error);
  const lines = ls.lines.map((l) => l.value).sort((a, b) => a.sequence - b.sequence);
  if (!invoiceMatchesLines(inv.value, lines)) return fail(409, "invoice_data_invalid", `${invoiceId} does not equal its stored lines (count / totals) - the data must be corrected first`);
  const ns = buildCreditNotes(noteRows, org.recordId);
  if (!ns.ok) return fail(409, "invoice_data_invalid", ns.error);
  const notes = ns.notes.map((n) => n.value).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (notes.some((n) => n.lines.some((c) => !lines.some((l) => l.lineId === c.invoiceLineId && l.occurrenceId === c.occurrenceId && l.grossMinor === c.grossMinor && l.netMinor === c.netMinor)))) return fail(409, "invoice_data_invalid", `A credit note of ${invoiceId} does not match the invoice's lines`);
  try {
    const st = creditState(inv.value, lines, notes);
    if (st.status !== inv.value.status) return fail(409, "invoice_data_invalid", `${invoiceId} says ${inv.value.status} but its credit notes say ${st.status}`);
  } catch (e) {
    return fail(409, "invoice_data_invalid", String((e as Error).message));
  }
  return { invoice: inv, lines, notes };
}

function invoiceBody(l: LoadedInvoice, links: { drafts: Draft[]; invoices: Invoice[] } | null) {
  const inv = l.invoice.value;
  const st = creditState(inv, l.lines, l.notes);
  const creditedBy = new Map(l.notes.flatMap((n) => n.lines.map((c) => [c.invoiceLineId, n.creditNoteId] as const)));
  return {
    invoice: publicInvoice(inv, st),
    lines: l.lines.map((x) => publicInvoiceLine(x, creditedBy.get(x.lineId) ?? null)),
    creditNotes: l.notes.map(publicCreditNote),
    links: {
      sourceDraftId: inv.sourceDraftId,
      replacesInvoiceId: inv.replacesInvoiceId,
      correctionId: inv.correctionId,
      corrections: links
        ? l.notes.map((n) => ({
            creditNoteId: n.creditNoteId,
            replacementDraftId: links.drafts.find((d) => d.correctionId === n.creditNoteId)?.draftId ?? null,
            replacementInvoiceId: links.invoices.find((i) => i.correctionId === n.creditNoteId)?.invoiceId ?? null,
          }))
        : [],
    },
    history: links ? invoiceHistory(inv, l.notes, links) : null,
  };
}

/** Invoices / drafts that replace `invoiceId` (2 reads). */
async function loadReplacements(deps: IssueDeps, org: OrganisationContext, invoiceId: string): Promise<{ drafts: Draft[]; invoices: Invoice[] } | Fail> {
  const r = await guarded(() => Promise.all([listDraftRowsReplacing(deps.airtable, org.recordId, invoiceId), listInvoiceRowsReplacing(deps.airtable, org.recordId, invoiceId)]));
  if (isFail(r)) return r;
  const d = buildDrafts(r[0], org.recordId);
  if (!d.ok) return fail(409, "invoice_draft_data_invalid", d.error);
  const i = buildInvoices(r[1], org.recordId);
  if (!i.ok) return fail(409, "invoice_data_invalid", i.error);
  return { drafts: d.drafts.map((x) => x.value), invoices: i.invoices.map((x) => x.value) };
}

// ---------------------------------------------------------------------
// Reads (View)
// ---------------------------------------------------------------------

export async function readInvoice(deps: IssueDeps, caller: FinanceCaller, invoiceId: string): Promise<Ok | Fail> {
  const auth = await authorizeFinance(deps, caller, "read");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  const [l, links] = await Promise.all([loadInvoice(deps, org, invoiceId), loadReplacements(deps, org, invoiceId)]);
  if (isFail(l)) return l;
  if (isFail(links)) return links;
  return { status: "ok", httpStatus: 200, body: { contract: ISSUE_CONTRACT, organisation: orgBody(org), access: auth.access, ...invoiceBody(l, links) } };
}

export async function listInvoiceCreditNotes(deps: IssueDeps, caller: FinanceCaller, invoiceId: string): Promise<Ok | Fail> {
  const auth = await authorizeFinance(deps, caller, "read");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  const l = await loadInvoice(deps, org, invoiceId);
  if (isFail(l)) return l;
  const st = creditState(l.invoice.value, l.lines, l.notes);
  return { status: "ok", httpStatus: 200, body: { contract: ISSUE_CONTRACT, organisation: orgBody(org), access: auth.access, invoiceId, status: l.invoice.value.status, credit: publicInvoice(l.invoice.value, st).credit, creditNotes: l.notes.map(publicCreditNote) } };
}

export async function listInvoices(deps: IssueDeps, caller: FinanceCaller, clientId: string): Promise<Ok | Fail> {
  const auth = await authorizeFinance(deps, caller, "read");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  const r = await guarded(() => Promise.all([listInvoiceRowsByClient(deps.airtable, org.recordId, clientId), listCreditNoteRowsByClient(deps.airtable, org.recordId, clientId)]));
  if (isFail(r)) return r;
  const i = buildInvoices(r[0], org.recordId);
  if (!i.ok) return fail(409, "invoice_data_invalid", i.error);
  const n = buildCreditNotes(r[1], org.recordId);
  if (!n.ok) return fail(409, "invoice_data_invalid", n.error);
  const invoices = i.invoices.map((x) => x.value).sort((a, b) => `${b.invoiceDate} ${b.issuedAt}`.localeCompare(`${a.invoiceDate} ${a.issuedAt}`));
  const notes = n.notes.map((x) => x.value);
  return {
    status: "ok",
    httpStatus: 200,
    body: {
      contract: ISSUE_CONTRACT,
      organisation: orgBody(org),
      access: auth.access,
      clientId,
      invoices: invoices.map((inv) => {
        const mine = notes.filter((x) => x.invoiceId === inv.invoiceId);
        const creditedGross = mine.reduce((a, x) => a + x.grossMinor, 0);
        const p = publicInvoice(inv);
        return { invoiceId: p.invoiceId, reference: p.reference, officialNumber: p.numbering.officialNumber, numberAuthority: p.numbering.authority, status: p.status, statusLabel: p.statusLabel, invoiceDate: p.invoiceDate, dueDate: p.dueDate, period: p.period, totals: p.totals, creditNotes: mine.map((x) => x.creditNoteId), creditedGross: formatMinor(creditedGross), replacesInvoiceId: p.replacesInvoiceId, sourceDraftId: p.sourceDraftId, external: p.external };
      }),
    },
  };
}

export async function readCreditNote(deps: IssueDeps, caller: FinanceCaller, creditNoteId: string): Promise<Ok | Fail> {
  const auth = await authorizeFinance(deps, caller, "read");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  const r = await guarded(() => Promise.all([findCreditNoteRows(deps.airtable, org.recordId, creditNoteId), listDraftRowsByCorrection(deps.airtable, org.recordId, creditNoteId), listInvoiceRowsByCorrection(deps.airtable, org.recordId, creditNoteId)]));
  if (isFail(r)) return r;
  const n = buildCreditNotes(r[0], org.recordId);
  if (!n.ok) return fail(409, "invoice_data_invalid", n.error);
  if (n.notes.length !== 1) return n.notes.length ? fail(409, "credit_note_ambiguous", "More than one credit note has this id") : fail(404, "credit_note_not_found", `No credit note ${creditNoteId} in your organisation`);
  const d = buildDrafts(r[1], org.recordId);
  if (!d.ok) return fail(409, "invoice_draft_data_invalid", d.error);
  const i = buildInvoices(r[2], org.recordId);
  if (!i.ok) return fail(409, "invoice_data_invalid", i.error);
  const note = n.notes[0].value;
  return {
    status: "ok",
    httpStatus: 200,
    body: {
      contract: ISSUE_CONTRACT,
      organisation: orgBody(org),
      access: auth.access,
      creditNote: publicCreditNote(note),
      links: { invoiceId: note.invoiceId, replacementDraftId: d.drafts[0]?.value.draftId ?? null, replacementInvoiceId: i.invoices[0]?.value.invoiceId ?? null },
    },
  };
}

// ---------------------------------------------------------------------
// Writes (Manage)
// ---------------------------------------------------------------------

type AuditRow = ReturnType<typeof issueAuditEvent>;
type Ctx = {
  org: OrganisationContext;
  atDate: Date;
  at: string;
  today: string;
  userId: string;
  ev: (eventType: string, entityType: string, recordId: string, before: Record<string, unknown> | null, after: Record<string, unknown>, reason: string | null, context?: Record<string, unknown>) => AuditRow;
  /** Also hold this organisation's Finance Settings lock until the request ends (null = held). */
  lockSettings: () => Promise<Fail | null>;
};
type Plan = { httpStatus: 200 | 201; run: (txn: DraftTxn) => Promise<{ events: AuditRow[]; body: () => Promise<Record<string, unknown>> | Record<string, unknown> }> } | Fail;

async function underLock(deps: IssueDeps, caller: FinanceCaller, route: string, plan: (ctx: Ctx) => Promise<Plan>): Promise<Ok | Fail> {
  const auth = await authorizeFinance(deps, caller, "manage");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  let token: string | null;
  try {
    token = await acquireWriteLock(deps.grants, lockKey(org));
  } catch (e) {
    console.error(e);
    return fail(503, "finance_invoices_unavailable", "The change could not be saved just now - try again");
  }
  if (!token) return fail(409, "finance_commercial_busy", "Finance is being changed by someone else right now - try again in a moment");
  let settingsToken: string | null = null;
  try {
    const atDate = now(deps);
    const ctx: Ctx = {
      org,
      atDate,
      at: atDate.toISOString(),
      today: todayIn(org.timezone, atDate),
      userId: caller.userId,
      ev: (eventType, entityType, recordId, before, after, reason, context = {}) => issueAuditEvent({ organisationId: org.organisationId, actorUserId: caller.userId, eventType, entityType, recordId, before, after, reason, route, context }),
      lockSettings: async () => {
        try {
          settingsToken = await acquireSettingsLock(deps.grants, org.organisationId);
        } catch (e) {
          console.error(e);
          return fail(503, "finance_invoices_unavailable", "The change could not be saved just now - try again");
        }
        return settingsToken ? null : fail(409, "finance_settings_busy", "Finance Settings are being changed right now - try again in a moment");
      },
    };
    const p = await plan(ctx);
    if ("status" in p) return p;
    const txn = new DraftTxn(deps);
    let result;
    try {
      result = await p.run(txn);
    } catch (e) {
      console.error(e);
      if (!(await txn.rollback())) return fail(500, "finance_invoices_unaudited", "The change was partly saved and could not be undone - contact support before changing this invoice again");
      return fail(503, "finance_invoices_unavailable", "The change could not be saved just now - nothing was changed");
    }
    try {
      await insertAuditEvents(deps.grants, result.events);
    } catch (e) {
      console.error(e);
      if (!(await txn.rollback())) return fail(500, "finance_invoices_unaudited", "The change was saved but could not be audited or undone - contact support before changing this invoice again");
      return fail(503, "finance_audit_unavailable", "The change could not be saved just now (it could not be recorded) - nothing was changed");
    }
    return { status: "ok", httpStatus: p.httpStatus, body: { contract: ISSUE_CONTRACT, organisation: orgBody(org), access: "manage", changed: true, ...(await result.body()) } };
  } finally {
    if (settingsToken) {
      try {
        await releaseSettingsLock(deps.grants, org.organisationId, settingsToken);
      } catch (e) {
        console.error("Finance Settings lock release failed (expires on its own)", e);
      }
    }
    try {
      await releaseWriteLock(deps.grants, lockKey(org), token);
    } catch (e) {
      console.error("Finance write lock release failed (expires on its own)", e);
    }
  }
}

/**
 * POST /invoice-drafts/{id}/issue - issue a Ready draft. Nothing is
 * refreshed: the lines issued are exactly the draft's Included lines, and
 * the F5 review is recomputed under the lock; any blocker refuses the issue.
 */
export function issueDraft(deps: IssueDeps, caller: FinanceCaller, draftId: string, revision: number, reason: string | null): Promise<Ok | Fail> {
  return underLock(deps, caller, `POST /invoice-drafts/${draftId}/issue`, async (c) => {
    // Settings (issuer + official numbering) are read and the Hub number advanced under the Settings lock too.
    const busy = await c.lockSettings();
    if (busy) return busy;
    const [l, existingRows] = await Promise.all([loadDraft(deps, c.org, draftId), guarded(() => listInvoiceRowsBySourceDraft(deps.airtable, c.org.recordId, draftId))]);
    if (isFail(l)) return l;
    if (isFail(existingRows)) return existingRows;
    const ex = buildInvoices(existingRows, c.org.recordId);
    if (!ex.ok) return fail(409, "invoice_data_invalid", ex.error);
    const draft = l.draft.value;
    const lines = l.lines.map((x) => x.value);
    const existingFromDraft = ex.invoices.map((x) => x.value);
    // Cheap refusals first (already issued / not Ready / stale revision) - no F4 run for them.
    const gate = issueGate(draft, existingFromDraft, revision);
    if (!gate.ok) return fail(gate.httpStatus, gate.code, gate.error);
    const cw = await loadClientWork(deps, c.org, draft.clientId, draft.periodFrom, draft.periodTo, c.atDate, c.today, lines.map((x) => x.occurrenceId), draft.correctionScope);
    if ("status" in cw) return cw;
    let replaced: Invoice | null = null;
    if (draft.replacesInvoiceId) {
      const rr = await guarded(() => findInvoiceRows(deps.airtable, c.org.recordId, draft.replacesInvoiceId as string));
      if (isFail(rr)) return rr;
      const one = oneInvoice(rr, c.org.recordId, draft.replacesInvoiceId);
      if (isFail(one) && one.httpStatus !== 404) return one;
      replaced = isFail(one) ? null : one.value;
    }
    // Hub numbering: the number this issue would take must not already be on an issued invoice (never reused).
    let numberTaken = false;
    const np = invoiceNumberPlan(cw.settings);
    if (np.ok && np.plan.authority === "hub") {
      const taken = await guarded(() => listInvoiceRowsByHubNumber(deps.airtable, c.org.recordId, np.plan.number as string));
      if (isFail(taken)) return taken;
      numberTaken = taken.length > 0;
    }
    const review = reviewDraft({ draft, lines, client: cw.client?.value ?? null, current: cw.current, work: cw.work, claims: cw.claims });
    const included = lines.filter((x) => x.status === "included");
    const invoiceId = newIssueId("FIV", hex(deps));
    const lineIds = uniqueFvl(deps, included.length);
    const cl = cw.client?.value ?? null;
    const p = planIssue({
      draft,
      lines,
      review,
      client: cl,
      settings: cw.settings,
      organisation: { organisationId: c.org.organisationId, name: c.org.name },
      existingFromDraft,
      numberTaken,
      replaced,
      reviewedRevision: revision,
      ids: { invoiceId, lineIds },
      meta: { userId: c.userId, at: c.at, today: c.today },
    });
    if (!p.ok) return fail(p.httpStatus, p.code, p.error, p.fields);
    const inv = p.invoice;
    const num = p.numbering;
    if (num.authority === "hub" && !cw.settingsRecordId) return fail(409, "invoice_numbering_not_configured", "Hub invoice numbering needs a Finance Settings record - nothing was issued");
    const after: Draft = { ...draft, issuedInvoiceId: inv.invoiceId, revision: draft.revision + 1, updatedBy: c.userId, updatedAt: c.at };
    const numbering = { authority: num.authority, officialNumber: num.number, sequence: num.sequence, nextNumberBefore: num.sequence, nextNumberAfter: num.nextAfter };
    return {
      httpStatus: 201,
      run: async (txn) => {
        // The Hub's next number advances in the same all-or-nothing write as the invoice (undone with it).
        if (num.authority === "hub") await txn.patch(SETTINGS_TABLE, [{ id: cw.settingsRecordId as string, fields: { [SETTINGS_FIELDS.invoiceNumberNext]: num.nextAfter }, restore: { [SETTINGS_FIELDS.invoiceNumberNext]: num.sequence } }]);
        const [created] = await txn.create(ISSUE_TABLES.invoices, [invoiceCreateFields(inv, c.org.recordId)]);
        await txn.create(ISSUE_TABLES.lines, p.lines.map((x) => invoiceLineCreateFields(x, c.org.recordId)));
        await txn.patch(INVOICING_TABLES.drafts, [{ id: l.draft.recordId, fields: draftFields(after, { userId: c.userId, at: c.at }), restore: draftRestoreFields(draft) }]);
        const events = [
          c.ev(ISSUE_EVENTS.issued, ENTITY_INVOICE, inv.invoiceId, null, { invoice: auditInvoice(inv), lines: p.lines.map(auditInvoiceLine) }, reason, { sourceDraftId: draft.draftId, reviewedRevision: revision, warnings: review.warnings.map((w) => w.code), approvedOmissions: inv.approvedOmissions.map((e) => e.occurrenceId), numbering }),
          c.ev(ISSUE_EVENTS.draftIssued, ENTITY_DRAFT, draft.draftId, auditDraft(draft), auditDraft(after), reason, { invoiceId: inv.invoiceId }),
        ];
        if (replaced) events.push(c.ev(ISSUE_EVENTS.replacementLinked, ENTITY_INVOICE, replaced.invoiceId, { status: replaced.status, revision: replaced.revision }, { replacementInvoiceId: inv.invoiceId, correctionId: inv.correctionId, status: replaced.status, revision: replaced.revision }, reason, { replacementDraftId: draft.draftId }));
        const stored: LoadedInvoice = { invoice: { recordId: created.id, value: inv }, lines: p.lines, notes: [] };
        return { events, body: () => ({ ...invoiceBody(stored, { drafts: [], invoices: [] }), draft: publicDraft(after) }) };
      },
    };
  });
}

function uniqueFvl(deps: IssueDeps, n: number): string[] {
  const taken = new Set<string>();
  const out: string[] = [];
  for (let k = 0; k < n; k++) {
    let id = "";
    for (let i = 0; i < 5 && (!id || taken.has(id)); i++) id = newIssueId("FVL", hex(deps));
    if (taken.has(id)) throw new Error("could not allocate a unique invoice line id");
    taken.add(id);
    out.push(id);
  }
  return out;
}

/**
 * POST /invoices/{id}/credit-notes - credit whole lines of an issued
 * invoice (all remaining lines when none are named). The invoice's lines
 * and amounts never change; only its credit state + revision are patched.
 */
export function createCreditNote(deps: IssueDeps, caller: FinanceCaller, invoiceId: string, lineIds: string[] | null, reason: string): Promise<Ok | Fail> {
  return underLock(deps, caller, `POST /invoices/${invoiceId}/credit-notes`, async (c) => {
    const l = await loadInvoice(deps, c.org, invoiceId);
    if (isFail(l)) return l;
    const inv = l.invoice.value;
    const p = planCreditNote({ invoice: inv, lines: l.lines, notes: l.notes, lineIds, reason, creditNoteId: newIssueId("FCN", hex(deps)), meta: { userId: c.userId, at: c.at, today: c.today } });
    if (!p.ok) return fail(p.httpStatus, p.code, p.error);
    const after: Invoice = { ...inv, status: p.statusAfter, revision: inv.revision + 1, updatedBy: c.userId, updatedAt: c.at };
    return {
      httpStatus: 201,
      run: async (txn) => {
        await txn.create(ISSUE_TABLES.creditNotes, [creditNoteCreateFields(p.note, c.org.recordId)]);
        await txn.patch(ISSUE_TABLES.invoices, [{ id: l.invoice.recordId, fields: invoiceStateFields(after), restore: invoiceStateFields(inv) }]);
        const remainingAfter = inv.grossMinor - p.before.credited.grossMinor - p.note.grossMinor;
        const events = [
          c.ev(ISSUE_EVENTS.creditNoteCreated, ENTITY_CREDIT_NOTE, p.note.creditNoteId, null, auditCreditNote(p.note), reason, { invoiceId, remainingGrossMinorBefore: p.before.remaining.grossMinor, remainingGrossMinorAfter: remainingAfter }),
          c.ev(p.statusAfter === "credited" ? ISSUE_EVENTS.credited : ISSUE_EVENTS.partiallyCredited, ENTITY_INVOICE, invoiceId, { status: inv.status, revision: inv.revision }, { status: after.status, revision: after.revision }, reason, { creditNoteId: p.note.creditNoteId }),
        ];
        const stored: LoadedInvoice = { invoice: { recordId: l.invoice.recordId, value: after }, lines: l.lines, notes: [...l.notes, p.note] };
        return { events, body: () => ({ creditNote: publicCreditNote(p.note), ...invoiceBody(stored, null) }) };
      },
    };
  });
}

/**
 * POST /credit-notes/{id}/replacement-draft - the correction path: a new F5
 * draft, scoped to exactly the credited occurrences, built from today's F4
 * results (the credited invoice's claims on those occurrences are released
 * to this draft only). Its payment terms, PO number, PO requirement and PO
 * override reason start as the ORIGINAL invoice's frozen values (terms
 * source "original_invoice") - never the client's current defaults. It then
 * goes through normal F5 review / Ready and F6 issue (where Management may
 * deliberately change terms / PO, audited as usual), and the replacement
 * invoice links back to the original.
 */
export function startReplacementDraft(deps: IssueDeps, caller: FinanceCaller, creditNoteId: string, reason: string): Promise<Ok | Fail> {
  return underLock(deps, caller, `POST /credit-notes/${creditNoteId}/replacement-draft`, async (c) => {
    const r = await guarded(() => Promise.all([findCreditNoteRows(deps.airtable, c.org.recordId, creditNoteId), listDraftRowsByCorrection(deps.airtable, c.org.recordId, creditNoteId), listInvoiceRowsByCorrection(deps.airtable, c.org.recordId, creditNoteId)]));
    if (isFail(r)) return r;
    const n = buildCreditNotes(r[0], c.org.recordId);
    if (!n.ok) return fail(409, "invoice_data_invalid", n.error);
    if (n.notes.length !== 1) return n.notes.length ? fail(409, "credit_note_ambiguous", "More than one credit note has this id") : fail(404, "credit_note_not_found", `No credit note ${creditNoteId} in your organisation`);
    const note = n.notes[0].value;
    const ds = buildDrafts(r[1], c.org.recordId);
    if (!ds.ok) return fail(409, "invoice_draft_data_invalid", ds.error);
    const is = buildInvoices(r[2], c.org.recordId);
    if (!is.ok) return fail(409, "invoice_data_invalid", is.error);
    const existing = ds.drafts[0]?.value.draftId ?? is.invoices[0]?.value.invoiceId;
    if (existing) return fail(409, "replacement_exists", `${creditNoteId} already has its replacement (${existing}) - one correction has one replacement`);
    const l = await loadInvoice(deps, c.org, note.invoiceId);
    if (isFail(l)) return l;
    const inv = l.invoice.value;
    const src = await loadDraft(deps, c.org, inv.sourceDraftId);
    // The source draft normally exists; if it does not, only the invoice's own claims are released.
    if (isFail(src) && src.httpStatus !== 404) return src;
    const inherited = isFail(src) ? [] : src.draft.value.correctionScope?.releasedDraftIds ?? [];
    const scope = { correctionId: creditNoteId, invoiceId: inv.invoiceId, occurrenceIds: note.lines.map((x) => x.occurrenceId), releasedDraftIds: [...new Set([...inherited, inv.sourceDraftId])] };
    const cw: ClientWork | Fail = await loadClientWork(deps, c.org, inv.clientId, inv.periodFrom, inv.periodTo, c.atDate, c.today, [], scope);
    if ("status" in cw) return cw;
    if (!cw.client) return fail(409, "client_not_found", `Client ${inv.clientId} no longer exists in Finance - nothing was started`);
    const client = cw.client.value;
    if (client.billingMethod !== "hub") return fail(409, "manual_billing_client", `${client.name} is billed manually outside the Hub - no Hub replacement is made for it`);
    if (!cw.work.available.length) return fail(409, "no_replacement_work", `None of the work credited by ${creditNoteId} is billable today - there is nothing to re-bill (the credit note stands on its own)`);
    const [draftId] = uniqueIds(deps, "FID", 1, new Set());
    const lineIds = uniqueIds(deps, "FIL", cw.work.available.length, new Set());
    const lines: Line[] = cw.work.available.map((res, i) => lineFromResolution(res, { lineId: lineIds[i], draftId }, { userId: c.userId, at: c.at, resolvedOn: c.today }));
    // The replacement STARTS from the corrected invoice's own commercial details (terms, PO, PO requirement / override) -
    // never today's client defaults. Management may deliberately change them in the normal F5 review (details route).
    const draft: Draft = {
      draftId,
      clientId: client.clientId,
      clientName: client.name,
      status: "draft",
      periodFrom: inv.periodFrom,
      periodTo: inv.periodTo,
      paymentTermsDays: inv.paymentTermsDays,
      paymentTermsSource: "original_invoice",
      poRequired: inv.poRequired,
      poNumber: inv.poNumber,
      poOverrideReason: inv.poOverrideReason,
      ...totalsOf(lines),
      revision: 1,
      createdBy: c.userId,
      createdAt: c.at,
      readyBy: null,
      readyAt: null,
      updatedBy: c.userId,
      updatedAt: c.at,
      termsExceptions: [],
      issuedInvoiceId: null,
      replacesInvoiceId: inv.invoiceId,
      correctionId: creditNoteId,
      correctionScope: scope,
    };
    return {
      httpStatus: 201,
      run: async (txn) => {
        await txn.create(INVOICING_TABLES.drafts, [draftFields(draft, { userId: c.userId, at: c.at }, c.org.recordId)]);
        await txn.create(INVOICING_TABLES.lines, lines.map((x) => lineCreateFields(x, c.org.recordId)));
        const events = [
          c.ev(ISSUE_EVENTS.correctionInitiated, ENTITY_INVOICE, inv.invoiceId, { status: inv.status, revision: inv.revision }, { creditNoteId, replacementDraftId: draftId, occurrenceIds: scope.occurrenceIds }, reason, { releasedDraftIds: scope.releasedDraftIds }),
          c.ev(DRAFT_EVENTS.created, ENTITY_DRAFT, draftId, null, { draft: auditDraft(draft), lines: lines.map(auditLine) }, reason, { clientId: client.clientId, periodFrom: draft.periodFrom, periodTo: draft.periodTo, lineCount: lines.length, replacesInvoiceId: inv.invoiceId, correctionId: creditNoteId }),
        ];
        const claims = [...cw.claims, ...lines.map((x) => ({ lineId: x.lineId, draftId, occurrenceId: x.occurrenceId }))];
        const afterWork: ClientWork = { ...cw, claims, work: classifyWork([...cw.current.values()], claims) };
        return { events, body: () => ({ correction: { creditNoteId, invoiceId: inv.invoiceId, replacementDraftId: draftId, occurrenceIds: scope.occurrenceIds }, ...draftBody(draft, lines, afterWork) }) };
      },
    };
  });
}
