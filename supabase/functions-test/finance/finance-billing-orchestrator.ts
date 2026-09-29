/**
 * Finance occurrence billing orchestration (Finance Foundation F4; see
 * TEST-ENV.md "Finance Foundation - F4"). Every route authorises through
 * F1's authorizeFinance() first - View resolves, Manage records billing
 * exceptions; no new auth.
 *
 * Reads: the F3 commercial snapshot (validated, lifecycle-aware) + the
 * Schedule facts (read only) + this organisation's overrides, then the pure
 * resolution in finance-billing.ts. A read never writes anything.
 *
 * Override writes (Manage only) follow the F3 write discipline exactly:
 *   1. authorise (manage)
 *   2. the per-organisation Finance write lock (shared with F3, so terms,
 *      lifecycle and billing exceptions never interleave) -> 409 busy
 *   3. load + resolve the occurrence (invalid data -> 409)
 *   4. validate / plan                         -> 400 / 404 / 409
 *      no effective change                     -> 200 changed:false, nothing written
 *   5. the Airtable writes (each registered with its undo)
 *   6. the audit event, in ONE insert
 *   Failure in 5 or 6 undoes this request's writes and returns 503; if the
 *   undo fails the caller gets 500 (never "success").
 *   7. release the lock (always)
 */
import type { FinanceCaller, OrganisationContext } from "./finance-access.ts";
import { authorizeFinance } from "./orchestrator.ts";
import { auditEvent, checkHistory, newId, todayIn } from "./finance-commercial.ts";
import type { Row, World } from "./finance-commercial-mapping.ts";
import { acquireWriteLock, insertAuditEvents, releaseWriteLock } from "./finance-commercial-repository.ts";
import { type CommercialDeps, Txn, lifecycleHistory, loadWorld } from "./finance-commercial-orchestrator.ts";
import {
  type Outcome,
  type Override,
  type OverrideRequest,
  type Resolution,
  type ServiceContext,
  BILLING_CONTRACT,
  ENTITY_OVERRIDE,
  OCCURRENCE_ID_PATTERN,
  OUTCOME_LABELS,
  OVERRIDE_EVENTS,
  planOverrideCreate,
  publicOverride,
  publicResolution,
  resolveOccurrenceBilling,
} from "./finance-billing.ts";
import { type StoredOverride, BILLING_TABLES, FB, buildOverrides, occurrenceFacts, occurrenceSessionRecordId, overrideCloseFields, overrideCreateFields } from "./finance-billing-mapping.ts";
import { findOccurrenceRows, findSessionRowsById, getSessionRow, listOverrideRows, listSessionOccurrenceRows } from "./finance-billing-repository.ts";
import { formatMinor } from "./finance-money.ts";

export type BillingDeps = CommercialDeps;

export type Fail = { status: "error"; httpStatus: 400 | 403 | 404 | 409 | 500 | 503; code: string; error: string; fields?: Record<string, string> };
export type Ok = { status: "ok"; httpStatus: 200 | 201; body: Record<string, unknown> };
const fail = (httpStatus: Fail["httpStatus"], code: string, error: string): Fail => ({ status: "error", httpStatus, code, error });

const now = (deps: BillingDeps) => (deps.clock ?? (() => new Date()))();
const hex = (deps: BillingDeps) => (deps.randomHex ?? (() => crypto.randomUUID()))();
const orgBody = (o: OrganisationContext) => ({ organisationId: o.organisationId, name: o.name });
const lockKey = (o: OrganisationContext) => `commercial:${o.organisationId}`;
const unavailable = () => fail(503, "finance_billing_unavailable", "Billing could not be resolved just now - try again");

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

type OccurrenceLoad = { world: World; occ: Row; session: Row | null; overrides: StoredOverride[] };

/** Loads everything one occurrence needs: snapshot, the occurrence, its Session and its overrides - a fixed number of reads. */
async function loadOccurrence(deps: BillingDeps, org: OrganisationContext, occurrenceId: string, today: string): Promise<OccurrenceLoad | Fail> {
  let occRows: Row[];
  let loaded;
  try {
    [loaded, occRows] = await Promise.all([loadWorld(deps, org, today), findOccurrenceRows(deps.airtable, occurrenceId)]);
  } catch (e) {
    console.error(e);
    return unavailable();
  }
  if (!loaded.ok) return loaded;
  if (occRows.length === 0) return fail(404, "occurrence_not_found", "No such session occurrence");
  if (occRows.length > 1) return fail(409, "occurrence_ambiguous", "More than one session occurrence has this Occurrence ID - Schedule data must be corrected first");
  const occ = occRows[0];
  const sessionRec = occurrenceSessionRecordId(occ);
  let session: Row | null;
  let overrideRows: Row[];
  try {
    [session, overrideRows] = await Promise.all([sessionRec ? getSessionRow(deps.airtable, sessionRec) : Promise.resolve(null), listOverrideRows(deps.airtable, org.recordId, [occurrenceId])]);
  } catch (e) {
    console.error(e);
    return unavailable();
  }
  const ov = buildOverrides(overrideRows, org.recordId);
  if (!ov.ok) return fail(409, "billing_override_data_invalid", ov.error);
  return { world: loaded.world, occ, session, overrides: ov.overrides };
}

const resolveLoaded = (l: { world: World; occ: Row; session: Row | null }, overrides: readonly Override[], at: Date, today: string): Resolution =>
  resolveOccurrenceBilling({ occurrence: occurrenceFacts(l.occ, l.session), findService: serviceFinder(l.world), overrides, now: at, today });

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

export async function readOccurrenceBilling(deps: BillingDeps, caller: FinanceCaller, occurrenceId: string): Promise<Ok | Fail> {
  const auth = await authorizeFinance(deps, caller, "read");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  const at = now(deps);
  const today = todayIn(org.timezone, at);
  const l = await loadOccurrence(deps, org, occurrenceId, today);
  if ("status" in l) return l;
  const r = resolveLoaded(l, l.overrides.map((o) => o.value), at, today);
  return { status: "ok", httpStatus: 200, body: { contract: BILLING_CONTRACT, organisation: orgBody(org), access: auth.access, billing: publicResolution(r, today) } };
}

/** Per-outcome counts and the eligible totals. Only "eligible" rows count towards billable value; nothing else is ever summed as money. */
export function summarise(rs: readonly Resolution[]) {
  const outcomes = Object.fromEntries((Object.keys(OUTCOME_LABELS) as Outcome[]).map((o) => [o, 0])) as Record<Outcome, number>;
  let net = 0;
  let vat = 0;
  let gross = 0;
  for (const r of rs) {
    outcomes[r.outcome]++;
    if (r.outcome === "eligible" && r.expected) {
      net += r.expected.netMinor;
      vat += r.expected.vatMinor;
      gross += r.expected.grossMinor;
    }
  }
  return {
    occurrences: rs.length,
    outcomes,
    eligibleBillableValue: { currency: "GBP", occurrences: outcomes.eligible, net: formatMinor(net), vat: formatMinor(vat), gross: formatMinor(gross) },
    needsAttention: rs.length - outcomes.eligible - outcomes.not_billable - outcomes.not_eligible - outcomes.deferred_revenue_model - outcomes.commercially_inactive,
  };
}

export async function readSessionBilling(deps: BillingDeps, caller: FinanceCaller, sessionId: string, from: string, to: string): Promise<Ok | Fail> {
  const auth = await authorizeFinance(deps, caller, "read");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  const at = now(deps);
  const today = todayIn(org.timezone, at);
  let loaded;
  let sessions: Row[];
  try {
    [loaded, sessions] = await Promise.all([loadWorld(deps, org, today), findSessionRowsById(deps.airtable, sessionId)]);
  } catch (e) {
    console.error(e);
    return unavailable();
  }
  if (!loaded.ok) return loaded;
  if (sessions.length === 0) return fail(404, "session_not_found", "No such session");
  if (sessions.length > 1) return fail(409, "session_ambiguous", "More than one session has this Session ID - Schedule data must be corrected first");
  const session = sessions[0];
  let occRows: Row[];
  let overrideRows: Row[];
  try {
    occRows = await listSessionOccurrenceRows(deps.airtable, { recordId: session.id, sessionId }, from, to);
    overrideRows = occRows.length ? await listOverrideRows(deps.airtable, org.recordId, occRows.map((o) => String(o.fields[FB.occurrence.id] ?? "")).filter((id) => OCCURRENCE_ID_PATTERN.test(id))) : [];
  } catch (e) {
    console.error(e);
    return unavailable();
  }
  const ov = buildOverrides(overrideRows, org.recordId);
  if (!ov.ok) return fail(409, "billing_override_data_invalid", ov.error);
  const overrides = ov.overrides.map((o) => o.value);
  const rs = occRows.map((occ) => resolveLoaded({ world: loaded.world, occ, session }, overrides, at, today));
  rs.sort((a, b) => `${a.occurrence.date} ${a.occurrence.start ?? ""} ${a.occurrence.occurrenceId}`.localeCompare(`${b.occurrence.date} ${b.occurrence.start ?? ""} ${b.occurrence.occurrenceId}`));
  const facts = occurrenceFacts({ id: "", fields: {} }, session);
  return {
    status: "ok",
    httpStatus: 200,
    body: {
      contract: BILLING_CONTRACT,
      organisation: orgBody(org),
      access: auth.access,
      session: { sessionId: facts.sessionId, sessionName: facts.sessionName, financeServiceId: facts.financeServiceRef },
      range: { from, to },
      resolvedOn: today,
      summary: summarise(rs),
      occurrences: rs.map((r) => publicResolution(r, today)),
    },
  };
}

// ---------------------------------------------------------------------
// Override writes
// ---------------------------------------------------------------------

export type OverrideInput =
  | { route: "override.create"; occurrenceId: string; req: OverrideRequest }
  | { route: "override.remove"; occurrenceId: string; overrideId: string; reason: string };

export async function writeOverride(deps: BillingDeps, caller: FinanceCaller, input: OverrideInput): Promise<Ok | Fail> {
  const auth = await authorizeFinance(deps, caller, "manage");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;

  let token: string | null;
  try {
    token = await acquireWriteLock(deps.grants, lockKey(org));
  } catch (e) {
    console.error(e);
    return fail(503, "finance_billing_unavailable", "The change could not be saved just now - try again");
  }
  if (!token) return fail(409, "finance_commercial_busy", "Finance setup is being changed by someone else right now - try again in a moment");

  try {
    const atDate = now(deps);
    const at = atDate.toISOString();
    const today = todayIn(org.timezone, atDate);
    const l = await loadOccurrence(deps, org, input.occurrenceId, today);
    if ("status" in l) return l;
    const current = l.overrides.map((o) => o.value);
    const before = resolveLoaded(l, current, atDate, today);
    const occ = before.occurrence;
    const base = { contract: BILLING_CONTRACT, organisation: orgBody(org), access: "manage" };
    const route = input.route === "override.create" ? `POST /occurrences/${occ.occurrenceId}/billing-overrides` : `POST /occurrences/${occ.occurrenceId}/billing-overrides/${input.overrideId}/remove`;
    const ev = (eventType: string, recordId: string, b: Record<string, unknown> | null, a: Record<string, unknown>, reason: string, context: Record<string, unknown>) => {
      const e = auditEvent({ organisationId: org.organisationId, actorUserId: caller.userId, eventType, entityType: ENTITY_OVERRIDE, recordId, before: b, after: a, reason, route, context });
      return { ...e, context: { ...e.context, contract: BILLING_CONTRACT } };
    };
    const ctx = (extra: Record<string, unknown>) => ({ occurrenceId: occ.occurrenceId, occurrenceDate: occ.date, sessionId: occ.sessionId, ...extra });

    let run: (txn: Txn) => Promise<{ events: ReturnType<typeof ev>[]; after: Override[]; override: Override }>;
    let status: 200 | 201;

    if (input.route === "override.create") {
      const plan = planOverrideCreate(current, input.req, before);
      if (!plan.ok) return fail(plan.httpStatus, plan.code, plan.error);
      if (plan.kind === "noop") return { status: "ok", httpStatus: 200, body: { ...base, changed: false, override: publicOverride(plan.existing), billing: publicResolution(before, today) } };
      const taken = current.map((o) => o.overrideId);
      let overrideId = "";
      for (let i = 0; i < 5 && (!overrideId || taken.includes(overrideId)); i++) overrideId = newId("FOB", hex(deps));
      if (taken.includes(overrideId)) throw new Error("could not allocate a unique override id");
      const created: Override = {
        overrideId,
        occurrenceId: occ.occurrenceId,
        kind: input.req.kind,
        quantity: input.req.quantity,
        amountMinor: input.req.amountMinor,
        reason: input.req.reason,
        serviceId: (before.service as ServiceContext).service.serviceId,
        termsId: before.terms?.termsId ?? null,
        createdAt: at,
        removedAt: null,
        removalReason: null,
        supersededBy: null,
      };
      const sup = plan.supersede;
      const closed: Override | null = sup ? { ...sup, removedAt: at, removalReason: `Superseded by ${overrideId}`, supersededBy: overrideId } : null;
      status = 201;
      run = async (txn) => {
        await txn.create(BILLING_TABLES.overrides, overrideCreateFields(created, { orgRecordId: org.recordId, occurrenceDate: occ.date, sessionId: occ.sessionId, userId: caller.userId, at }));
        if (sup && closed) {
          const rec = (l.overrides.find((o) => o.value.overrideId === sup.overrideId) as StoredOverride).recordId;
          await txn.patch(BILLING_TABLES.overrides, rec, overrideCloseFields({ at, userId: caller.userId, reason: closed.removalReason as string, supersededBy: overrideId }), overrideCloseFields(null));
        }
        return {
          events: [
            ev(OVERRIDE_EVENTS.created, overrideId, closed ? { superseded: publicOverride(sup as Override) } : null, publicOverride(created), input.req.reason, ctx({ serviceId: created.serviceId, termsId: created.termsId, supersededOverrideId: sup?.overrideId ?? null })),
          ],
          after: [...current.map((o) => (closed && o.overrideId === closed.overrideId ? closed : o)), created],
          override: created,
        };
      };
    } else {
      const found = l.overrides.find((o) => o.value.overrideId === input.overrideId);
      if (!found) return fail(404, "billing_override_not_found", `No override ${input.overrideId} on this occurrence`);
      const o = found.value;
      if (o.removedAt !== null) return { status: "ok", httpStatus: 200, body: { ...base, changed: false, override: publicOverride(o), billing: publicResolution(before, today) } };
      const closed: Override = { ...o, removedAt: at, removalReason: input.reason, supersededBy: null };
      status = 200;
      run = async (txn) => {
        await txn.patch(BILLING_TABLES.overrides, found.recordId, overrideCloseFields({ at, userId: caller.userId, reason: input.reason, supersededBy: null }), overrideCloseFields(null));
        return {
          events: [ev(OVERRIDE_EVENTS.removed, o.overrideId, publicOverride(o), publicOverride(closed), input.reason, ctx({ serviceId: o.serviceId, termsId: o.termsId, kind: o.kind }))],
          after: current.map((x) => (x.overrideId === o.overrideId ? closed : x)),
          override: closed,
        };
      };
    }

    const txn = new Txn(deps);
    let result;
    try {
      result = await run(txn);
    } catch (e) {
      console.error(e);
      if (!(await txn.rollback())) return fail(500, "finance_billing_unaudited", "The change was partly saved and could not be undone - contact support before changing this again");
      return fail(503, "finance_billing_unavailable", "The change could not be saved just now - nothing was changed");
    }
    try {
      await insertAuditEvents(deps.grants, result.events);
    } catch (e) {
      console.error(e);
      if (!(await txn.rollback())) return fail(500, "finance_billing_unaudited", "The change was saved but could not be audited or undone - contact support before changing this again");
      return fail(503, "finance_audit_unavailable", "The change could not be saved just now (it could not be recorded) - nothing was changed");
    }
    const after = resolveLoaded(l, result.after, atDate, today);
    return { status: "ok", httpStatus: status, body: { ...base, changed: true, override: publicOverride(result.override), billing: publicResolution(after, today) } };
  } finally {
    try {
      await releaseWriteLock(deps.grants, lockKey(org), token);
    } catch (e) {
      console.error("Finance write lock release failed (expires on its own)", e);
    }
  }
}
