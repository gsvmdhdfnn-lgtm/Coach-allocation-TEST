/**
 * Test-suite copy of the canonical finance/finance-supplier-credits.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). No changes.
 */
/**
 * Supplier / venue credits - pure logic (Finance Foundation F14; see
 * TEST-ENV.md "Finance Foundation - F14"). Builds on F13's supplier ledger.
 *
 *   Credit (FSC-)       one genuine supplier credit / refund / compensation,
 *                       on the supplier record. Its original amount is kept
 *                       forever; what is left is DERIVED from its
 *                       applications (never a stored balance).
 *   Application (FSX-)  Management explicitly applies part or all of a
 *                       credit to one confirmed, unsettled instalment of the
 *                       SAME supplier. Unapply sets a reversal on the row
 *                       (the row is never deleted). Nothing is auto-applied.
 *
 * Two separate effects, never mixed (locked decisions, 2026-10-01):
 *   - COST: a credit is one cost correction, dated when it is recorded, with
 *     a Management-chosen scope - specific session(s), the whole agreement,
 *     or the supplier only. F13's frozen session shares are never rewritten:
 *     gross original cost + separate credit adjustment = net real cost.
 *   - PAYABLE: applying a credit only lowers what is still owed on an
 *     instalment (remainingOf = due - cash paid - credit applied). It never
 *     reduces cost a second time, and it is never a payment or income.
 *
 * A settled instalment (remaining 0, by cash and / or credit) is frozen:
 * no apply, no unapply - mistakes there belong to the future correction flow.
 */
import { type Agreement, type Allocation, type Instalment, type Invalid, type Refusal, type Supplier, AGREEMENT_ID_RE, INSTALMENT_ID_RE, SUPPLIER_ID_RE, date, isRealDate, isSettled, jsonObject, m, money, remainingOf, spreadEvenly, text } from "./finance-suppliers.ts";
import { auditEvent } from "./finance-commercial.ts";

export const CREDIT_CONTRACT = "finance-supplier-credits-v1";
export const CREDIT_ID_RE = /^FSC-[0-9A-F]{12}$/;
export const APPLICATION_ID_RE = /^FSX-[0-9A-F]{12}$/;
const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;
export const MAX_CREDIT_SESSIONS = 100;

export const CREDIT_SCOPES = ["sessions", "agreement", "supplier"] as const;
export type CreditScope = (typeof CREDIT_SCOPES)[number];
export const CREDIT_SCOPE_LABELS: Record<CreditScope, string> = {
  sessions: "Specific session(s)",
  agreement: "Whole agreement",
  supplier: "Supplier only (not attributed to sessions)",
};
export const CREDIT_SOURCES = ["credit_note", "refund_adjustment", "compensation"] as const;
export type CreditSource = (typeof CREDIT_SOURCES)[number];
export const CREDIT_SOURCE_LABELS: Record<CreditSource, string> = {
  credit_note: "Supplier-issued credit note",
  refund_adjustment: "Venue refund / adjustment",
  compensation: "Agreed supplier compensation",
};
export const CREDIT_STATUSES = ["available", "partially_applied", "fully_applied", "voided"] as const;
export type CreditStatus = (typeof CREDIT_STATUSES)[number];
export const CREDIT_STATUS_LABELS: Record<CreditStatus, string> = {
  available: "Available",
  partially_applied: "Partially Applied",
  fully_applied: "Fully Applied",
  voided: "Voided",
};
export const CREDIT_EVENTS = {
  created: "finance_supplier_credit.created",
  applied: "finance_supplier_credit.applied",
  unapplied: "finance_supplier_credit.unapplied",
  voided: "finance_supplier_credit.voided",
} as const;
export const CREDIT_ENTITY = "finance_supplier_credit";

export interface SupplierCredit {
  organisationId: string;
  creditId: string;
  supplierId: string;
  agreementId: string | null;
  scope: CreditScope;
  amountMinor: number;
  currency: "GBP";
  creditDate: string;
  sourceType: CreditSource;
  sourceReference: string;
  reason: string;
  /** Agreement scope only: the Finance Service the adjustment is attributed to (frozen at creation; null = agreement level, no single service). */
  financeServiceId: string | null;
  programmeLabel: string | null;
  createdAt: string;
  createdBy: string;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
}
/** Specific-sessions scope: the credit's cost adjustment per selected occurrence, frozen at creation. */
export interface CreditSession {
  organisationId: string;
  creditId: string;
  occurrenceRecordId: string;
  occurrenceRef: string | null;
  occurrenceDate: string;
  sessionId: string | null;
  sessionName: string | null;
  financeServiceId: string | null;
  programmeLabel: string | null;
  adjustmentMinor: number;
}
export interface CreditApplication {
  organisationId: string;
  applicationId: string;
  creditId: string;
  instalmentId: string;
  agreementId: string;
  supplierId: string;
  amountMinor: number;
  appliedAt: string;
  appliedBy: string;
  reason: string | null;
  unappliedAt: string | null;
  unappliedBy: string | null;
  unapplyReason: string | null;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const isActive = (a: CreditApplication) => !a.unappliedAt;
/** Credit applied right now (active applications only). */
export const creditAppliedOf = (c: SupplierCredit, apps: CreditApplication[]) => sum(apps.filter((a) => a.creditId === c.creditId && isActive(a)).map((a) => a.amountMinor));
/** What is left to apply: original amount - active applications. Derived, never stored. */
export const creditRemainingOf = (c: SupplierCredit, apps: CreditApplication[]) => (c.voidedAt ? 0 : c.amountMinor - creditAppliedOf(c, apps));
export function creditStatusOf(c: SupplierCredit, apps: CreditApplication[]): CreditStatus {
  if (c.voidedAt) return "voided";
  const applied = creditAppliedOf(c, apps);
  return applied === 0 ? "available" : applied === c.amountMinor ? "fully_applied" : "partially_applied";
}

// ---------------------------------------------------------------------
// Cost attribution (frozen at creation; F13 shares are never touched)
// ---------------------------------------------------------------------
/** Spread the credit equally (exact pence, spare pennies to the earliest) over the selected sessions' F13 allocation rows. */
export function sessionsAttribution(organisationId: string, creditId: string, amountMinor: number, allocations: Allocation[], occurrenceIds: string[]): CreditSession[] {
  const picked = allocations.filter((x) => occurrenceIds.includes(x.occurrenceRecordId)).sort((a, b) => (a.occurrenceDate < b.occurrenceDate ? -1 : a.occurrenceDate > b.occurrenceDate ? 1 : a.occurrenceRecordId < b.occurrenceRecordId ? -1 : 1));
  const shares = spreadEvenly(amountMinor, picked.length);
  return picked.map((x, k) => ({
    organisationId,
    creditId,
    occurrenceRecordId: x.occurrenceRecordId,
    occurrenceRef: x.occurrenceRef,
    occurrenceDate: x.occurrenceDate,
    sessionId: x.sessionId,
    sessionName: x.sessionName,
    financeServiceId: x.financeServiceId,
    programmeLabel: x.programmeLabel,
    adjustmentMinor: shares[k],
  }));
}
/** Whole-agreement scope: the agreement's single Finance Service (its link, or the one service all its sessions share); otherwise agreement level only. */
export function agreementAttribution(a: Agreement, allocations: Allocation[]): { financeServiceId: string | null; programmeLabel: string | null } {
  const mine = allocations.filter((x) => x.agreementId === a.agreementId);
  const services = [...new Set(mine.map((x) => x.financeServiceId).filter((x): x is string => !!x))];
  const fsv = a.linkFinanceServiceId ?? (services.length === 1 && mine.every((x) => x.financeServiceId === services[0]) ? services[0] : null);
  const labels = [...new Set(mine.filter((x) => x.financeServiceId === fsv).map((x) => x.programmeLabel).filter((x): x is string => !!x))].sort();
  return { financeServiceId: fsv, programmeLabel: fsv && labels.length ? labels.join(" / ") : null };
}
export type AdjustmentRow = { creditId: string; financeServiceId: string | null; label: string | null; amountMinor: number; sessionDate: string | null; sessionId: string | null };
/**
 * The cost adjustment rows one (non-voided) credit contributes to a by-Finance-Service view.
 * The correction itself is dated when the credit was recorded (one credit = one cost
 * correction - callers filter by creditDate); a specific-session credit keeps the session
 * it is attributed to alongside (sessionDate).
 * Supplier-only credits contribute none (they are not attributed to sessions).
 */
export function adjustmentRows(c: SupplierCredit, sessions: CreditSession[]): AdjustmentRow[] {
  if (c.voidedAt || c.scope === "supplier") return [];
  if (c.scope === "agreement") return [{ creditId: c.creditId, financeServiceId: c.financeServiceId, label: c.programmeLabel, amountMinor: c.amountMinor, sessionDate: null, sessionId: null }];
  return sessions.filter((s) => s.creditId === c.creditId).map((s) => ({ creditId: c.creditId, financeServiceId: s.financeServiceId, label: s.programmeLabel, amountMinor: s.adjustmentMinor, sessionDate: s.occurrenceDate, sessionId: s.sessionId }));
}
/** Gross (F13 frozen shares, untouched) + separate credit adjustment = net, per Finance Service. */
export function netByFinanceService(gross: { financeServiceId: string | null; label: string | null; amountMinor: number }[], adjustments: { financeServiceId: string | null; label: string | null; amountMinor: number }[]) {
  const g = new Map<string, { financeServiceId: string | null; labels: Set<string>; grossMinor: number; adjustmentMinor: number }>();
  const add = (r: { financeServiceId: string | null; label: string | null; amountMinor: number }, k: "grossMinor" | "adjustmentMinor") => {
    const key = r.financeServiceId ?? "unresolved";
    const x = g.get(key) ?? { financeServiceId: r.financeServiceId, labels: new Set<string>(), grossMinor: 0, adjustmentMinor: 0 };
    if (r.label) x.labels.add(r.label);
    x[k] += r.amountMinor;
    g.set(key, x);
  };
  gross.forEach((r) => add(r, "grossMinor"));
  adjustments.forEach((r) => add(r, "adjustmentMinor"));
  return [...g.values()]
    .sort((a, b) => (a.financeServiceId === null ? 1 : b.financeServiceId === null ? -1 : a.financeServiceId < b.financeServiceId ? -1 : 1))
    .map((x) => ({ financeServiceId: x.financeServiceId, resolved: x.financeServiceId !== null, labels: [...x.labels].sort(), gross: m(x.grossMinor), creditAdjustment: m(x.adjustmentMinor), net: m(x.grossMinor - x.adjustmentMinor) }));
}
/** Cost and payable figures for one set of instalments + credits, kept as separate numbers. */
export function costFigures(instalments: Instalment[], credits: SupplierCredit[]) {
  const live = instalments.filter((i) => !i.cancelledAt);
  const gross = sum(live.map((i) => i.amountDueMinor));
  const adjustment = sum(credits.filter((c) => !c.voidedAt).map((c) => c.amountMinor));
  return {
    cost: { gross: m(gross), creditAdjustment: m(adjustment), net: m(gross - adjustment) },
    payable: { amountDue: m(gross), cashPaid: m(sum(live.map((i) => i.paidMinor))), creditApplied: m(sum(live.map((i) => i.creditedMinor))), remainingPayable: m(sum(live.map(remainingOf))) },
  };
}

// ---------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------
export function applicationView(a: CreditApplication) {
  return {
    applicationId: a.applicationId,
    creditId: a.creditId,
    instalmentId: a.instalmentId,
    agreementId: a.agreementId,
    amount: m(a.amountMinor),
    active: isActive(a),
    appliedAt: a.appliedAt,
    appliedBy: a.appliedBy,
    reason: a.reason,
    unapplied: a.unappliedAt ? { at: a.unappliedAt, by: a.unappliedBy, reason: a.unapplyReason } : null,
  };
}
export function creditView(c: SupplierCredit, apps: CreditApplication[], sessions: CreditSession[]) {
  const mine = apps.filter((a) => a.creditId === c.creditId);
  const status = creditStatusOf(c, apps);
  return {
    creditId: c.creditId,
    supplierId: c.supplierId,
    agreementId: c.agreementId,
    currency: c.currency,
    /** The original credit - never changes. */
    amount: m(c.amountMinor),
    applied: m(creditAppliedOf(c, apps)),
    remaining: m(creditRemainingOf(c, apps)),
    status,
    statusLabel: CREDIT_STATUS_LABELS[status],
    creditDate: c.creditDate,
    source: { type: c.sourceType, label: CREDIT_SOURCE_LABELS[c.sourceType], reference: c.sourceReference },
    reason: c.reason,
    costAdjustment: {
      scope: c.scope,
      scopeLabel: CREDIT_SCOPE_LABELS[c.scope],
      amount: c.voidedAt ? m(0) : m(c.amountMinor),
      date: c.creditDate,
      financeServiceId: c.scope === "agreement" ? c.financeServiceId : null,
      programme: c.scope === "agreement" ? c.programmeLabel : null,
      sessions: sessions.filter((s) => s.creditId === c.creditId).map((s) => ({ date: s.occurrenceDate, sessionId: s.sessionId, session: s.sessionName, financeServiceId: s.financeServiceId, programme: s.programmeLabel, adjustment: m(s.adjustmentMinor), technical: { occurrenceRecordId: s.occurrenceRecordId, occurrenceId: s.occurrenceRef } })),
      note: "One credit = one cost correction, dated when recorded. Applying it to an instalment only lowers what is still payable.",
    },
    applications: mine.map(applicationView),
    voided: c.voidedAt ? { at: c.voidedAt, by: c.voidedBy, reason: c.voidReason } : null,
    createdAt: c.createdAt,
    createdBy: c.createdBy,
    /** Not a payment, not income, not a discount. */
    kind: "supplier_credit",
  };
}
export function auditCredit(c: SupplierCredit, apps: CreditApplication[]) {
  return { creditId: c.creditId, supplierId: c.supplierId, agreementId: c.agreementId, scope: c.scope, amount: m(c.amountMinor), applied: m(creditAppliedOf(c, apps)), remaining: m(creditRemainingOf(c, apps)), status: creditStatusOf(c, apps) };
}
export function creditAudit(a: { organisationId: string; actorUserId: string; eventType: string; recordId: string; before: Record<string, unknown> | null; after: Record<string, unknown>; reason: string | null; route: string }) {
  const e = auditEvent({ ...a, entityType: CREDIT_ENTITY });
  return { ...e, context: { ...e.context, contract: CREDIT_CONTRACT } };
}

// ---------------------------------------------------------------------
// Routes - no auto-apply, no delete, no edit-in-place
// ---------------------------------------------------------------------
export const CREDIT_ACTIONS = ["apply", "unapply", "void"] as const;
export type CreditAction = (typeof CREDIT_ACTIONS)[number];
export type CreditRoute =
  | { name: "credits.list"; params: Record<string, never> }
  | { name: "credits.create"; params: Record<string, never> }
  | { name: "credits.one"; params: { creditId: string } }
  | { name: "credits.action"; params: { creditId: string; action: CreditAction } };
export type CreditMatch = { status: "match"; route: CreditRoute } | { status: "method"; allowed: string[] } | { status: "not_found" } | null;
export function matchCreditRoute(path: string, method: string): CreditMatch {
  const seg = path.split("/");
  if (seg[0] !== "supplier-credits") return null;
  const pick = (byMethod: Partial<Record<string, CreditRoute>>): CreditMatch => {
    const r = byMethod[method];
    return r ? { status: "match", route: r } : { status: "method", allowed: Object.keys(byMethod) };
  };
  if (seg.length === 1) return pick({ GET: { name: "credits.list", params: {} }, POST: { name: "credits.create", params: {} } });
  if (CREDIT_ID_RE.test(seg[1] ?? "")) {
    if (seg.length === 2) return pick({ GET: { name: "credits.one", params: { creditId: seg[1] } } });
    if (seg.length === 3 && (CREDIT_ACTIONS as readonly string[]).includes(seg[2])) return pick({ POST: { name: "credits.action", params: { creditId: seg[1], action: seg[2] as CreditAction } } });
  }
  return { status: "not_found" };
}

// ---------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------
const invalid = (code: string, error: string, fields?: Record<string, string>): Invalid => ({ ok: false, httpStatus: 400, code, error, ...(fields ? { fields } : {}) });
const TENANT_ERROR = "The organisation is taken from your profile and cannot be chosen in the request";

export type CreditQuery = { ok: true; supplierId?: string; agreementId?: string; status?: CreditStatus };
export function parseCreditQuery(route: CreditRoute["name"], q: URLSearchParams, isTenantKey: (k: string) => boolean): CreditQuery | Invalid {
  const keys = [...q.keys()];
  if (keys.some(isTenantKey)) return invalid("tenant_param_rejected", TENANT_ERROR);
  const ok = route === "credits.list" ? ["supplierId", "agreementId", "status"] : [];
  const bad = keys.filter((k) => !ok.includes(k));
  if (bad.length) return invalid("unexpected_parameter", `Unexpected query parameter(s): ${[...new Set(bad)].join(", ")}`);
  if (new Set(keys).size !== keys.length) return invalid("unexpected_parameter", "A query parameter is repeated");
  const out: CreditQuery = { ok: true };
  const sid = q.get("supplierId");
  if (sid !== null) {
    if (!SUPPLIER_ID_RE.test(sid)) return invalid("invalid_query", "supplierId must be a supplier id (FSU-...)");
    out.supplierId = sid;
  }
  const aid = q.get("agreementId");
  if (aid !== null) {
    if (!AGREEMENT_ID_RE.test(aid)) return invalid("invalid_query", "agreementId must be an agreement id (FSA-...)");
    out.agreementId = aid;
  }
  const st = q.get("status");
  if (st !== null) {
    if (!(CREDIT_STATUSES as readonly string[]).includes(st)) return invalid("invalid_query", `status must be one of ${CREDIT_STATUSES.join(", ")}`);
    out.status = st as CreditStatus;
  }
  return out;
}

export interface CreditInput {
  supplierId: string;
  scope: CreditScope;
  agreementId: string | null;
  occurrenceIds: string[];
  amountMinor: number;
  creditDate: string;
  sourceType: CreditSource;
  sourceReference: string;
  reason: string;
}
export const CREDIT_FIELDS = ["supplierId", "scope", "agreementId", "occurrenceIds", "amount", "creditDate", "sourceType", "sourceReference", "reason"] as const;
export function parseCreditCreate(raw: string, isTenantKey: (k: string) => boolean): { ok: true; input: CreditInput } | Invalid {
  const b = jsonObject(raw, CREDIT_FIELDS, isTenantKey);
  if (!b.ok) return b;
  const x = b.body;
  const f: Record<string, string> = {};
  if (typeof x.supplierId !== "string" || !SUPPLIER_ID_RE.test(x.supplierId)) f.supplierId = "is required (FSU-...)";
  const scope = (CREDIT_SCOPES as readonly unknown[]).includes(x.scope) ? (x.scope as CreditScope) : null;
  if (!scope) f.scope = `is required: one of ${CREDIT_SCOPES.join(", ")} (sessions = specific session(s), agreement = whole agreement, supplier = supplier only)`;
  let agreementId: string | null = null;
  if (x.agreementId !== undefined && x.agreementId !== null) {
    if (typeof x.agreementId !== "string" || !AGREEMENT_ID_RE.test(x.agreementId)) f.agreementId = "must be an agreement id (FSA-...)";
    else agreementId = x.agreementId;
  }
  if ((scope === "sessions" || scope === "agreement") && !agreementId && !f.agreementId) f.agreementId = "is required for a session or whole-agreement credit";
  if (scope === "supplier" && agreementId) f.agreementId = "a supplier-only credit is not attributed to an agreement";
  let occurrenceIds: string[] = [];
  if (x.occurrenceIds !== undefined && x.occurrenceIds !== null) {
    if (!Array.isArray(x.occurrenceIds) || !x.occurrenceIds.length || x.occurrenceIds.length > MAX_CREDIT_SESSIONS || x.occurrenceIds.some((o) => typeof o !== "string" || !RECORD_ID_RE.test(o))) f.occurrenceIds = `must be 1-${MAX_CREDIT_SESSIONS} session occurrence record ids (rec...)`;
    else occurrenceIds = [...new Set(x.occurrenceIds as string[])];
  }
  if (scope === "sessions" && !occurrenceIds.length && !f.occurrenceIds) f.occurrenceIds = "is required: the session occurrence(s) this credit is for";
  if (scope && scope !== "sessions" && occurrenceIds.length) f.occurrenceIds = "is only for a specific-session(s) credit";
  const amount = money(x.amount, f, "amount", true);
  const creditDate = date(x.creditDate, f, "creditDate", true);
  const sourceType = (CREDIT_SOURCES as readonly unknown[]).includes(x.sourceType) ? (x.sourceType as CreditSource) : null;
  if (!sourceType) f.sourceType = `is required: one of ${CREDIT_SOURCES.join(", ")}`;
  const ref = text(x.sourceReference, true, 200);
  if (!ref.ok) f.sourceReference = ref.error;
  const reason = text(x.reason, true);
  if (!reason.ok) f.reason = reason.error;
  if (Object.keys(f).length) return invalid("invalid_input", "Some fields are not valid - nothing was saved", f);
  return {
    ok: true,
    input: { supplierId: x.supplierId as string, scope: scope as CreditScope, agreementId, occurrenceIds, amountMinor: amount as number, creditDate: creditDate as string, sourceType: sourceType as CreditSource, sourceReference: (ref as { value: string }).value, reason: (reason as { value: string }).value },
  };
}
export type CreditActionInput =
  | { action: "apply"; instalmentId: string; amountMinor: number; reason: string | null }
  | { action: "unapply"; applicationId: string; reason: string }
  | { action: "void"; reason: string };
export function parseCreditAction(action: CreditAction, raw: string, isTenantKey: (k: string) => boolean): { ok: true; input: CreditActionInput } | Invalid {
  const allowed: Record<CreditAction, string[]> = { apply: ["instalmentId", "amount", "reason"], unapply: ["applicationId", "reason"], void: ["reason"] };
  const b = jsonObject(raw, allowed[action], isTenantKey);
  if (!b.ok) return b;
  const x = b.body;
  const f: Record<string, string> = {};
  const done = (input: CreditActionInput): { ok: true; input: CreditActionInput } | Invalid => (Object.keys(f).length ? invalid("invalid_input", "Some fields are not valid - nothing was changed", f) : { ok: true, input });
  if (action === "apply") {
    if (typeof x.instalmentId !== "string" || !INSTALMENT_ID_RE.test(x.instalmentId)) f.instalmentId = "is required (FSI-...)";
    const a = money(x.amount, f, "amount", true);
    const r = text(x.reason, false);
    if (!r.ok) f.reason = r.error;
    return done({ action, instalmentId: x.instalmentId as string, amountMinor: a as number, reason: r.ok ? r.value : null });
  }
  const r = text(x.reason, true);
  if (!r.ok) f.reason = r.error;
  if (action === "unapply") {
    if (typeof x.applicationId !== "string" || !APPLICATION_ID_RE.test(x.applicationId)) f.applicationId = "is required (FSX-...)";
    return done({ action, applicationId: x.applicationId as string, reason: (r.ok ? r.value : "") as string });
  }
  return done({ action: "void", reason: (r.ok ? r.value : "") as string });
}

// ---------------------------------------------------------------------
// Planning (the database re-checks every rule)
// ---------------------------------------------------------------------
const refuse = (httpStatus: 400 | 404 | 409, code: string, error: string): Refusal => ({ ok: false, httpStatus, code, error });

/** Validate a new credit against the ledger; returns its frozen cost attribution. */
export function planCredit(
  input: CreditInput,
  ctx: { organisationId: string; creditId: string; today: string; supplier: Supplier | undefined; agreement: Agreement | undefined; allocations: Allocation[]; existing: SupplierCredit[] },
): { ok: true; sessions: CreditSession[]; financeServiceId: string | null; programmeLabel: string | null } | Refusal {
  if (!isRealDate(input.creditDate) || input.creditDate > ctx.today) return refuse(400, "invalid_input", "creditDate cannot be in the future - record the credit when it is genuinely given");
  if (!ctx.supplier) return refuse(404, "supplier_not_found", `No supplier ${input.supplierId}`);
  // The supplier's own reference identifies a genuine credit: a retried request can never record it twice.
  if (ctx.existing.some((c) => !c.voidedAt && c.supplierId === input.supplierId && c.sourceType === input.sourceType && c.sourceReference.toLowerCase() === input.sourceReference.toLowerCase()))
    return refuse(409, "duplicate_credit", "A credit with this source and reference is already recorded for this supplier");
  if (input.scope === "supplier") return { ok: true, sessions: [], financeServiceId: null, programmeLabel: null };
  if (!ctx.agreement) return refuse(404, "agreement_not_found", `No agreement ${input.agreementId}`);
  if (ctx.agreement.supplierId !== input.supplierId) return refuse(409, "agreement_not_for_supplier", "That agreement belongs to a different supplier");
  const allocations = ctx.allocations.filter((x) => x.agreementId === ctx.agreement!.agreementId);
  if (input.scope === "agreement") return { ok: true, sessions: [], ...agreementAttribution(ctx.agreement, allocations) };
  if (ctx.agreement.classification !== "direct" || ctx.agreement.linkState !== "linked") return refuse(409, "agreement_has_no_sessions", "That agreement has no agreed sessions to attribute a credit to - use a whole-agreement or supplier-only credit");
  const known = new Set(allocations.map((x) => x.occurrenceRecordId));
  const unknown = input.occurrenceIds.filter((o) => !known.has(o));
  if (unknown.length) return refuse(409, "session_not_in_agreement", `These sessions are not among the agreement's agreed sessions: ${unknown.join(", ")}`);
  return { ok: true, sessions: sessionsAttribution(ctx.organisationId, ctx.creditId, input.amountMinor, allocations, input.occurrenceIds), financeServiceId: null, programmeLabel: null };
}

/** Apply part / all of a credit to one instalment. Never automatic; never more than either side has left. */
export function planApply(
  c: SupplierCredit,
  apps: CreditApplication[],
  i: Instalment | undefined,
  input: { instalmentId: string; amountMinor: number; reason: string | null },
  ctx: { actor: string; at: string; applicationId: string },
): { ok: true; application: CreditApplication; nextInstalment: Instalment } | Refusal {
  if (c.voidedAt) return refuse(409, "credit_voided", "This credit was voided - it cannot be applied");
  if (!i) return refuse(404, "instalment_not_found", `No instalment ${input.instalmentId}`);
  if (i.supplierId !== c.supplierId) return refuse(409, "wrong_supplier", "A credit can only be applied to an instalment of the same supplier");
  if (i.cancelledAt) return refuse(409, "instalment_cancelled", "That instalment was cancelled");
  if (i.amountState !== "confirmed") return refuse(409, "instalment_estimated", "Confirm the instalment amount first - a credit is only applied to a confirmed amount");
  if (isSettled(i)) return refuse(409, "instalment_settled", "That instalment is already settled - nothing remains to credit");
  // One active application per credit per instalment: a retried request can never apply the same credit twice.
  if (apps.some((a) => a.creditId === c.creditId && a.instalmentId === i.instalmentId && isActive(a))) return refuse(409, "already_applied_to_instalment", "This credit is already applied to that instalment - unapply it first to change the amount");
  const creditLeft = creditRemainingOf(c, apps);
  if (input.amountMinor > creditLeft) return refuse(409, "over_credit", `Only ${m(creditLeft)} of this credit remains - ${m(input.amountMinor)} is more than that`);
  const owed = remainingOf(i);
  if (input.amountMinor > owed) return refuse(409, "over_instalment", `Only ${m(owed)} remains on that instalment - ${m(input.amountMinor)} would over-credit it`);
  return {
    ok: true,
    application: { organisationId: c.organisationId, applicationId: ctx.applicationId, creditId: c.creditId, instalmentId: i.instalmentId, agreementId: i.agreementId, supplierId: c.supplierId, amountMinor: input.amountMinor, appliedAt: ctx.at, appliedBy: ctx.actor, reason: input.reason, unappliedAt: null, unappliedBy: null, unapplyReason: null },
    nextInstalment: { ...i, creditedMinor: i.creditedMinor + input.amountMinor },
  };
}

/** Reverse one active application while the instalment is not yet settled. The row stays, marked unapplied. */
export function planUnapply(
  c: SupplierCredit,
  apps: CreditApplication[],
  i: Instalment | undefined,
  input: { applicationId: string; reason: string },
  ctx: { actor: string; at: string },
): { ok: true; application: CreditApplication; nextInstalment: Instalment } | Refusal {
  const app = apps.find((a) => a.applicationId === input.applicationId && a.creditId === c.creditId);
  if (!app) return refuse(404, "application_not_found", `No application ${input.applicationId} on this credit`);
  if (!isActive(app)) return refuse(409, "already_unapplied", "That application was already unapplied");
  if (!i) return refuse(404, "instalment_not_found", `No instalment ${app.instalmentId}`);
  if (isSettled(i)) return refuse(409, "instalment_settled", "That instalment is settled - the applied credit is now frozen history (use a correction later)");
  return { ok: true, application: { ...app, unappliedAt: ctx.at, unappliedBy: ctx.actor, unapplyReason: input.reason }, nextInstalment: { ...i, creditedMinor: i.creditedMinor - app.amountMinor } };
}

/** Only a credit that has never been applied can be voided. */
export function planVoid(c: SupplierCredit, apps: CreditApplication[], input: { reason: string }, ctx: { actor: string; at: string }): { ok: true; credit: SupplierCredit } | Refusal {
  if (c.voidedAt) return refuse(409, "already_voided", "This credit is already voided");
  if (apps.some((a) => a.creditId === c.creditId)) return refuse(409, "credit_has_applications", "This credit has been applied - unapply where allowed; it can never simply be voided once used");
  return { ok: true, credit: { ...c, voidedAt: ctx.at, voidedBy: ctx.actor, voidReason: input.reason } };
}
