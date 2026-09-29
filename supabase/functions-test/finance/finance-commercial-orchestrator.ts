/**
 * Finance commercial setup orchestration (Finance Foundation F3; see
 * TEST-ENV.md "Finance Foundation - F3"). Every route authorises through
 * F1's authorizeFinance() first - View reads, Manage writes; no new auth.
 *
 * Writes (Manage only), in order - nothing is written before step 5:
 *   1. authorise (manage)
 *   2. per-organisation Finance write lock          -> 409 finance_commercial_busy
 *   3. load this organisation's clients/services/terms (invalid data -> 409)
 *   4. validate the request against that snapshot   -> 400 / 404 / 409
 *      no effective change                          -> 200 changed:false, nothing written
 *   5. the Airtable writes (each one registered with its undo)
 *   6. the audit events for the request, in ONE insert
 *   Any failure in 5 or 6 undoes every write of this request and returns
 *   503; if the undo itself fails the caller gets 500 (never "success").
 *   7. release the lock (always)
 *
 * F4: a Service's status is its dated lifecycle (finance-lifecycle.ts). The
 * status shown and used for every rule here is the period covering today;
 * a status change is a lifecycle change from `effectiveFrom` (today or
 * later, default today). The stored Status cell is only a convenience copy
 * of today's status at the last write - never read back as the truth.
 */
import type { FinanceCaller, OrganisationContext } from "./finance-access.ts";
import { type Deps, authorizeFinance } from "./orchestrator.ts";
import { type FinanceSettings, fromStoredRow } from "./finance-settings.ts";
import { loadSettingsRows } from "./finance-settings-repository.ts";
import {
  type AuditEvent,
  type ChangeRequest,
  type Client,
  type ClientPatch,
  type CommercialRoute,
  type InitialTermsRequest,
  type Service,
  type ServicePatch,
  type Terms,
  COMMERCIAL_CONTRACT,
  ENTITY_CLIENT,
  ENTITY_SERVICE,
  ENTITY_TERMS,
  EVENTS,
  auditEvent,
  auditTerms,
  checkHistory,
  completeTerms,
  newClient,
  newId,
  planChange,
  publicClient,
  publicService,
  publicTerms,
  sameTerms,
  termsFieldsOf,
  termsOn,
  todayIn,
} from "./finance-commercial.ts";
import {
  type Row,
  type World,
  TABLES,
  buildWorld,
  clientFields,
  clientRestoreFields,
  serviceFields,
  serviceRestoreFields,
  lifecycleCreateFields,
  lifecycleSupersededField,
  lifecycleUntilField,
  termsCreateFields,
  termsUntilField,
} from "./finance-commercial-mapping.ts";
import { acquireWriteLock, createRow, deleteCreatedRow, insertAuditEvents, loadCommercialRows, patchRow, releaseWriteLock } from "./finance-commercial-repository.ts";
import { type LifecyclePeriod, checkLifecycle, lifecycleOn, planLifecycleChange, publicLifecycle } from "./finance-lifecycle.ts";

export interface CommercialDeps extends Deps {
  clock?: () => Date;
  randomHex?: () => string;
}

export type Fail = { status: "error"; httpStatus: 400 | 403 | 404 | 409 | 500 | 503; code: string; error: string; fields?: Record<string, string> };
export type Ok = { status: "ok"; httpStatus: 200 | 201; body: Record<string, unknown> };
const fail = (httpStatus: Fail["httpStatus"], code: string, error: string, fields?: Record<string, string>): Fail => ({ status: "error", httpStatus, code, error, ...(fields ? { fields } : {}) });

const now = (deps: CommercialDeps) => (deps.clock ?? (() => new Date()))();
const hex = (deps: CommercialDeps) => (deps.randomHex ?? (() => crypto.randomUUID()))();
const orgBody = (o: OrganisationContext) => ({ organisationId: o.organisationId, name: o.name });
const lockKey = (o: OrganisationContext) => `commercial:${o.organisationId}`;
const norm = (s: string) => s.trim().toLowerCase();

type RawRows = { clients: Row[]; services: Row[]; terms: Row[]; lifecycle: Row[] };

/** Loads and validates the organisation's commercial data, then sets each service's status to its lifecycle period covering `today`. */
export async function loadWorld(deps: CommercialDeps, org: OrganisationContext, today: string): Promise<{ ok: true; world: World; raw: RawRows } | Fail> {
  let raw;
  try {
    raw = await loadCommercialRows(deps.airtable, org.recordId);
  } catch (e) {
    console.error(e);
    return fail(503, "finance_commercial_unavailable", "Clients and services could not be loaded just now - try again");
  }
  const w = buildWorld(raw);
  if (!w.ok) return fail(409, "commercial_data_invalid", w.error);
  const services = [];
  for (const s of w.world.services) {
    const cur = lifecycleOn(lifecycleHistory(w.world, s.value.serviceId), today);
    if (cur.status !== "resolved") return fail(409, "commercial_data_invalid", `Service ${s.value.serviceId} has no lifecycle period covering ${today}`);
    services.push({ recordId: s.recordId, value: { ...s.value, status: cur.period.status } });
  }
  return { ok: true, world: { ...w.world, services }, raw };
}

/** The applying (non-superseded) lifecycle periods of a service, sorted; validated by buildWorld. */
export function lifecycleHistory(world: World, serviceId: string): LifecyclePeriod[] {
  const h = checkLifecycle(world.lifecycle.filter((l) => l.value.serviceId === serviceId).map((l) => l.value));
  return h.ok ? h.history : [];
}

const serviceBody = (s: Service, c: Client, terms: Terms[], lifecycle: LifecyclePeriod[], today: string, on?: string) => {
  const body = publicService(s, c, terms, today, on);
  if (on !== undefined) {
    const lc = lifecycleOn(lifecycle, on);
    (body.commercial as Record<string, unknown>).onDate = { ...((body.commercial as Record<string, unknown>).onDate as Record<string, unknown>), serviceStatus: lc.status === "resolved" ? lc.period.status : null };
  }
  return { ...body, lifecycle: publicLifecycle(lifecycle, today) };
};

async function loadSettings(deps: CommercialDeps, org: OrganisationContext): Promise<{ ok: true; settings: FinanceSettings | null } | Fail> {
  let rows;
  try {
    rows = await loadSettingsRows(deps.airtable, org.recordId);
  } catch (e) {
    console.error(e);
    return fail(503, "finance_settings_unavailable", "Finance Settings could not be loaded just now - try again");
  }
  if (rows.length === 0) return { ok: true, settings: null };
  if (rows.length > 1) return fail(409, "finance_settings_ambiguous", "More than one Finance Settings record exists for your organisation");
  const p = fromStoredRow(rows[0]);
  if (!p.ok) return fail(409, "finance_settings_invalid", `Stored Finance Settings are not valid (${p.problems.join(", ")})`);
  return { ok: true, settings: p.state.settings };
}

function history(world: World, serviceId: string): { ok: true; terms: Terms[] } | Fail {
  const h = checkHistory(world.terms.filter((t) => t.value.serviceId === serviceId).map((t) => t.value));
  return h.ok ? { ok: true, terms: h.history } : fail(409, h.code, h.error);
}

const findClient = (w: World, id: string) => w.clients.find((c) => c.value.clientId === id);
const findService = (w: World, id: string) => w.services.find((s) => s.value.serviceId === id);

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

export async function readCommercial(deps: CommercialDeps, caller: FinanceCaller, route: CommercialRoute, on?: string): Promise<Ok | Fail> {
  const auth = await authorizeFinance(deps, caller, "read");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  const today = todayIn(org.timezone, now(deps));
  const loaded = await loadWorld(deps, org, today);
  if (!loaded.ok) return loaded;
  const w = loaded.world;
  const base = { contract: COMMERCIAL_CONTRACT, organisation: orgBody(org), access: auth.access };

  const serviceCard = (s: Service): Record<string, unknown> | Fail => {
    const h = history(w, s.serviceId);
    if (!h.ok) return h;
    const cur = termsOn(h.terms, today);
    return { serviceId: s.serviceId, name: s.name, status: s.status, currentSummary: cur.status === "resolved" ? publicTerms(cur.terms, today).summary : null };
  };

  if (route.name === "clients.list") {
    const clients = [];
    for (const c of [...w.clients].sort((a, b) => a.value.name.localeCompare(b.value.name))) {
      const cards = [];
      for (const s of w.services.filter((x) => x.value.clientId === c.value.clientId)) {
        const card = serviceCard(s.value);
        if ((card as Fail).status === "error") return card as Fail;
        cards.push(card);
      }
      clients.push({ ...publicClient(c.value), services: cards });
    }
    return { status: "ok", httpStatus: 200, body: { ...base, today, clients } };
  }

  if (route.name === "client.read") {
    const c = findClient(w, route.params.clientId);
    if (!c) return fail(404, "client_not_found", "No such client in your organisation");
    const services = [];
    for (const s of w.services.filter((x) => x.value.clientId === c.value.clientId)) {
      const h = history(w, s.value.serviceId);
      if (!h.ok) return h;
      services.push(serviceBody(s.value, c.value, h.terms, lifecycleHistory(w, s.value.serviceId), today));
    }
    return { status: "ok", httpStatus: 200, body: { ...base, client: publicClient(c.value), services } };
  }

  if (route.name === "service.read") {
    const s = findService(w, route.params.serviceId);
    if (!s) return fail(404, "service_not_found", "No such service in your organisation");
    const c = findClient(w, s.value.clientId) as { value: Client };
    const h = history(w, s.value.serviceId);
    if (!h.ok) return h;
    return { status: "ok", httpStatus: 200, body: { ...base, service: serviceBody(s.value, c.value, h.terms, lifecycleHistory(w, s.value.serviceId), today, on) } };
  }

  if (route.name === "options") {
    const options = [];
    for (const s of w.services) {
      const c = findClient(w, s.value.clientId) as { value: Client };
      if (s.value.status !== "active" || c.value.status !== "active") continue;
      const h = history(w, s.value.serviceId);
      if (!h.ok) return h;
      const cur = termsOn(h.terms, today);
      options.push({
        serviceId: s.value.serviceId,
        serviceName: s.value.name,
        clientId: c.value.clientId,
        clientName: c.value.name,
        commercial: cur.status === "resolved" ? publicTerms(cur.terms, today) : null,
      });
    }
    options.sort((a, b) => `${a.clientName} ${a.serviceName}`.localeCompare(`${b.clientName} ${b.serviceName}`));
    return { status: "ok", httpStatus: 200, body: { ...base, today, options } };
  }
  return fail(404, "not_found", "Unknown route");
}

// ---------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------

/** Compensating transaction: every write registers its undo (also used by the F4 billing overrides). */
export class Txn {
  private undo: { label: string; run: () => Promise<unknown> }[] = [];
  private deps: CommercialDeps;
  constructor(deps: CommercialDeps) {
    this.deps = deps;
  }
  async create(table: string, fields: Record<string, unknown>): Promise<Row> {
    const row = await createRow(this.deps.airtable, table, fields);
    this.undo.push({ label: `delete ${table} ${row.id}`, run: () => deleteCreatedRow(this.deps.airtable, table, row.id) });
    return row;
  }
  async patch(table: string, recordId: string, fields: Record<string, unknown>, restore: Record<string, unknown>): Promise<Row> {
    const row = await patchRow(this.deps.airtable, table, recordId, fields);
    this.undo.push({ label: `restore ${table} ${recordId}`, run: () => patchRow(this.deps.airtable, table, recordId, restore) });
    return row;
  }
  /** true when every write of this request was undone. */
  async rollback(): Promise<boolean> {
    for (const u of [...this.undo].reverse()) {
      try {
        await u.run();
      } catch (e) {
        console.error(`FINANCE COMMERCIAL UNDO FAILED (${u.label})`, e);
        return false;
      }
    }
    return true;
  }
}

type Plan = { ok: true; status: 200 | 201; run: (txn: Txn) => Promise<{ events: AuditEvent[]; body: Record<string, unknown> }> } | { ok: true; noop: Record<string, unknown> } | Fail;

export type WriteInput =
  | { route: "clients.create"; client: ClientPatch & { name: string }; reason: string | null }
  | { route: "client.update"; clientId: string; patch: ClientPatch; reason: string | null }
  | { route: "services.create"; clientId: string; name: string; initial: InitialTermsRequest | null; reason: string | null }
  | { route: "service.update"; serviceId: string; patch: ServicePatch; effectiveFrom?: string | null; reason: string | null }
  | { route: "terms.create"; serviceId: string; req: InitialTermsRequest; reason: string | null }
  | { route: "terms.change"; serviceId: string; req: ChangeRequest; reason: string | null };

export async function writeCommercial(deps: CommercialDeps, caller: FinanceCaller, input: WriteInput): Promise<Ok | Fail> {
  const auth = await authorizeFinance(deps, caller, "manage");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;

  let token: string | null;
  try {
    token = await acquireWriteLock(deps.grants, lockKey(org));
  } catch (e) {
    console.error(e);
    return fail(503, "finance_commercial_unavailable", "The change could not be saved just now - try again");
  }
  if (!token) return fail(409, "finance_commercial_busy", "Clients and services are being changed by someone else right now - try again in a moment");

  try {
    const at = now(deps).toISOString();
    const today = todayIn(org.timezone, now(deps));
    const loaded = await loadWorld(deps, org, today);
    if (!loaded.ok) return loaded;
    const plan = await planWrite(deps, org, caller, input, loaded.world, loaded.raw, at, today);
    if (!plan.ok) return plan;
    if ("noop" in plan) return { status: "ok", httpStatus: 200, body: { contract: COMMERCIAL_CONTRACT, organisation: orgBody(org), access: "manage", changed: false, ...plan.noop } };

    const txn = new Txn(deps);
    let result;
    try {
      result = await plan.run(txn);
    } catch (e) {
      console.error(e);
      if (!(await txn.rollback())) return fail(500, "finance_commercial_unaudited", "The change was partly saved and could not be undone - contact support before changing this again");
      return fail(503, "finance_commercial_unavailable", "The change could not be saved just now - nothing was changed");
    }
    try {
      await insertAuditEvents(deps.grants, result.events);
    } catch (e) {
      console.error(e);
      if (!(await txn.rollback())) return fail(500, "finance_commercial_unaudited", "The change was saved but could not be audited or undone - contact support before changing this again");
      return fail(503, "finance_audit_unavailable", "The change could not be saved just now (it could not be recorded) - nothing was changed");
    }
    return { status: "ok", httpStatus: plan.status, body: { contract: COMMERCIAL_CONTRACT, organisation: orgBody(org), access: "manage", changed: true, ...result.body } };
  } finally {
    try {
      await releaseWriteLock(deps.grants, lockKey(org), token);
    } catch (e) {
      console.error("Finance write lock release failed (expires on its own)", e);
    }
  }
}

async function planWrite(
  deps: CommercialDeps,
  org: OrganisationContext,
  caller: FinanceCaller,
  input: WriteInput,
  w: World,
  raw: RawRows,
  at: string,
  today: string
): Promise<Plan> {
  const meta = { userId: caller.userId, at };
  const ev = (eventType: string, entityType: string, recordId: string, before: Record<string, unknown> | null, after: Record<string, unknown>, route: string, context?: Record<string, unknown>) =>
    auditEvent({ organisationId: org.organisationId, actorUserId: caller.userId, eventType, entityType, recordId, before, after, reason: input.reason, route, context });
  const rawRow = (rows: Row[], id: string) => rows.find((r) => r.id === id) as Row;
  const uniqueId = (prefix: "FCL" | "FSV" | "FCT" | "FSL", taken: string[]) => {
    for (let i = 0; i < 5; i++) {
      const id = newId(prefix, hex(deps));
      if (!taken.includes(id)) return id;
    }
    throw new Error("could not allocate a unique id");
  };

  if (input.route === "clients.create") {
    if (w.clients.some((c) => norm(c.value.name) === norm(input.client.name))) return fail(409, "duplicate_client_name", `A client called "${input.client.name}" already exists`);
    const client = { ...newClient(uniqueId("FCL", w.clients.map((c) => c.value.clientId)), input.client), updatedAt: at };
    return {
      ok: true,
      status: 201,
      run: async (txn) => {
        await txn.create(TABLES.clients, clientFields(client, meta, org.recordId));
        return { events: [ev(EVENTS.clientCreated, ENTITY_CLIENT, client.clientId, null, publicClient(client), "POST /clients")], body: { client: publicClient(client), services: [] } };
      },
    };
  }

  if (input.route === "client.update") {
    const found = findClient(w, input.clientId);
    if (!found) return fail(404, "client_not_found", "No such client in your organisation");
    const before = found.value;
    const merged: Client = { ...before, ...input.patch } as Client;
    const changed = (Object.keys(input.patch) as (keyof Client)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(merged[k]));
    if (!changed.length) return { ok: true, noop: { client: publicClient(before) } };
    if (changed.includes("name") && w.clients.some((c) => c.value.clientId !== before.clientId && norm(c.value.name) === norm(merged.name))) return fail(409, "duplicate_client_name", `A client called "${merged.name}" already exists`);
    const after: Client = { ...merged, revision: before.revision + 1, updatedAt: at };
    return {
      ok: true,
      status: 200,
      run: async (txn) => {
        await txn.patch(TABLES.clients, found.recordId, clientFields(after, meta), clientRestoreFields(before, rawRow(raw.clients, found.recordId)));
        return {
          events: [ev(EVENTS.clientUpdated, ENTITY_CLIENT, before.clientId, publicClient(before), publicClient(after), `POST /clients/${before.clientId}`, { changedFields: changed })],
          body: { client: publicClient(after) },
        };
      },
    };
  }

  const needSettings = input.route === "terms.create" || input.route === "terms.change" || (input.route === "services.create" && input.initial !== null);
  let settings: FinanceSettings | null = null;
  if (needSettings) {
    const s = await loadSettings(deps, org);
    if (!s.ok) return s;
    settings = s.settings;
  }

  if (input.route === "services.create") {
    const c = findClient(w, input.clientId);
    if (!c) return fail(404, "client_not_found", "No such client in your organisation");
    if (c.value.status !== "active") return fail(409, "client_inactive", "This client is inactive - reactivate it before adding services");
    if (w.services.some((s) => s.value.clientId === c.value.clientId && norm(s.value.name) === norm(input.name))) return fail(409, "duplicate_service_name", `This client already has a service called "${input.name}"`);
    const service: Service = { serviceId: uniqueId("FSV", w.services.map((s) => s.value.serviceId)), clientId: c.value.clientId, name: input.name, status: "active", revision: 1, updatedAt: at };
    const initial: LifecyclePeriod = { lifecycleId: uniqueId("FSL", w.lifecycle.map((l) => l.value.lifecycleId)), serviceId: service.serviceId, status: "active", effectiveFrom: null, effectiveUntil: null, supersededBy: null, reason: null };
    let terms: Terms | null = null;
    if (input.initial) {
      const t = completeTerms(input.initial.input, null, settings);
      if (!t.ok) return t;
      terms = { termsId: uniqueId("FCT", w.terms.map((x) => x.value.termsId)), serviceId: service.serviceId, effectiveFrom: input.initial.effectiveFrom, effectiveUntil: null, ...t.terms };
    }
    return {
      ok: true,
      status: 201,
      run: async (txn) => {
        const row = await txn.create(TABLES.services, serviceFields(service, meta, { orgRecordId: org.recordId, clientRecordId: c.recordId }));
        await txn.create(TABLES.lifecycle, lifecycleCreateFields(initial, { orgRecordId: org.recordId, serviceRecordId: row.id, ...meta }));
        const route = `POST /clients/${c.value.clientId}/services`;
        const events = [ev(EVENTS.serviceCreated, ENTITY_SERVICE, service.serviceId, null, { serviceId: service.serviceId, clientId: service.clientId, name: service.name, status: service.status, revision: 1 }, route, { initialLifecycle: { lifecycleId: initial.lifecycleId, status: "active", effectiveFrom: null } })];
        if (terms) {
          await txn.create(TABLES.terms, termsCreateFields(terms, { orgRecordId: org.recordId, serviceRecordId: row.id, ...meta }));
          events.push(ev(EVENTS.termsCreated, ENTITY_TERMS, terms.termsId, null, auditTerms(terms), route, { serviceId: service.serviceId, inline: true }));
        }
        return { events, body: { service: serviceBody(service, c.value, terms ? [terms] : [], [initial], today) } };
      },
    };
  }

  const s = findService(w, input.serviceId);
  if (!s) return fail(404, "service_not_found", "No such service in your organisation");
  const client = (findClient(w, s.value.clientId) as { value: Client }).value;
  const h = history(w, s.value.serviceId);
  if (!h.ok) return h;
  // Ended = no longer operating, kept for history. The ONLY write it accepts is
  // reactivation (status -> active, no rename); its commercial terms are never
  // touched by the lifecycle change - a new price is a separate dated change.
  const reactivation = s.value.status === "ended" && input.route === "service.update" && input.patch.status === "active" && (input.patch.name === undefined || input.patch.name === s.value.name);
  if (s.value.status === "ended" && !reactivation) return fail(409, "service_ended", "This service has ended - reactivate it (status active) before changing it; its history is kept");

  const lc = lifecycleHistory(w, s.value.serviceId);

  if (input.route === "service.update") {
    const before = s.value;
    const nameChanged = input.patch.name !== undefined && input.patch.name !== before.name;
    let plan: ReturnType<typeof planLifecycleChange> | null = null;
    if (input.patch.status !== undefined) {
      plan = planLifecycleChange(lc, input.patch.status, input.effectiveFrom ?? today, today);
      if (!plan.ok) return fail(plan.httpStatus, plan.code, plan.error);
    }
    const lifecycleChange = plan !== null && plan.ok && plan.kind !== "noop" ? plan : null;
    if (!nameChanged && !lifecycleChange) return { ok: true, noop: { service: serviceBody(before, client, h.terms, lc, today) } };
    const name = nameChanged ? (input.patch.name as string) : before.name;
    if (nameChanged && w.services.some((x) => x.value.clientId === before.clientId && x.value.serviceId !== before.serviceId && norm(x.value.name) === norm(name))) return fail(409, "duplicate_service_name", `This client already has a service called "${name}"`);

    let next: LifecyclePeriod | null = null;
    let newLifecycle = lc;
    if (lifecycleChange) {
      next = { lifecycleId: uniqueId("FSL", w.lifecycle.map((l) => l.value.lifecycleId)), serviceId: before.serviceId, status: lifecycleChange.next.status, effectiveFrom: lifecycleChange.next.effectiveFrom, effectiveUntil: null, supersededBy: null, reason: input.reason };
      newLifecycle =
        lifecycleChange.kind === "append"
          ? [...lc.slice(0, -1), { ...lifecycleChange.close, effectiveUntil: lifecycleChange.closedUntil }, next]
          : [...lc.slice(0, -1), next];
    }
    const todayPeriod = lifecycleOn(newLifecycle, today);
    const after: Service = { ...before, name, status: todayPeriod.status === "resolved" ? todayPeriod.period.status : before.status, revision: before.revision + 1, updatedAt: at };
    const changed = [...(nameChanged ? ["name"] : []), ...(lifecycleChange ? ["status"] : [])];
    const recOf = (id: string) => (w.lifecycle.find((l) => l.value.lifecycleId === id) as { recordId: string }).recordId;
    const shape = (x: Service) => ({ serviceId: x.serviceId, clientId: x.clientId, name: x.name, status: x.status, revision: x.revision });
    return {
      ok: true,
      status: 200,
      run: async (txn) => {
        await txn.patch(TABLES.services, s.recordId, serviceFields(after, meta), serviceRestoreFields(before, rawRow(raw.services, s.recordId)));
        if (lifecycleChange && next) {
          if (lifecycleChange.kind === "append") {
            await txn.patch(TABLES.lifecycle, recOf(lifecycleChange.close.lifecycleId), lifecycleUntilField(lifecycleChange.closedUntil), lifecycleUntilField(lifecycleChange.close.effectiveUntil));
            await txn.create(TABLES.lifecycle, lifecycleCreateFields(next, { orgRecordId: org.recordId, serviceRecordId: s.recordId, ...meta }));
          } else {
            await txn.create(TABLES.lifecycle, lifecycleCreateFields(next, { orgRecordId: org.recordId, serviceRecordId: s.recordId, ...meta }));
            await txn.patch(TABLES.lifecycle, recOf(lifecycleChange.replace.lifecycleId), lifecycleSupersededField(next.lifecycleId), lifecycleSupersededField(null));
          }
        }
        const lifecycleContext =
          lifecycleChange && next
            ? {
                lifecycleChange: {
                  kind: lifecycleChange.kind,
                  lifecycleId: next.lifecycleId,
                  status: next.status,
                  effectiveFrom: next.effectiveFrom,
                  ...(lifecycleChange.kind === "append"
                    ? { closedLifecycleId: lifecycleChange.close.lifecycleId, closedUntil: lifecycleChange.closedUntil }
                    : { supersededLifecycleId: lifecycleChange.replace.lifecycleId, supersededStatus: lifecycleChange.replace.status }),
                },
              }
            : {};
        return {
          events: [
            ev(EVENTS.serviceUpdated, ENTITY_SERVICE, before.serviceId, shape(before), shape(after), `POST /services/${before.serviceId}`, {
              changedFields: changed,
              ...(reactivation ? { lifecycle: "reactivated" } : {}),
              ...lifecycleContext,
            }),
          ],
          body: { service: serviceBody(after, client, h.terms, newLifecycle, today) },
        };
      },
    };
  }

  if (input.route === "terms.create") {
    if (h.terms.length) return fail(409, "commercial_terms_exist", "This service already has a commercial setup - apply a change from a date instead");
    const t = completeTerms(input.req.input, null, settings);
    if (!t.ok) return t;
    const terms: Terms = { termsId: uniqueId("FCT", w.terms.map((x) => x.value.termsId)), serviceId: s.value.serviceId, effectiveFrom: input.req.effectiveFrom, effectiveUntil: null, ...t.terms };
    return {
      ok: true,
      status: 201,
      run: async (txn) => {
        await txn.create(TABLES.terms, termsCreateFields(terms, { orgRecordId: org.recordId, serviceRecordId: s.recordId, ...meta }));
        return {
          events: [ev(EVENTS.termsCreated, ENTITY_TERMS, terms.termsId, null, auditTerms(terms), `POST /services/${s.value.serviceId}/commercial`, { serviceId: s.value.serviceId })],
          body: { service: serviceBody(s.value, client, [terms], lc, today) },
        };
      },
    };
  }

  // terms.change
  const plan = planChange(h.terms, input.req.effectiveFrom, today);
  if (!plan.ok) return fail(plan.httpStatus, plan.code, plan.error);
  const t = completeTerms(input.req.changes, termsFieldsOf(plan.close), settings);
  if (!t.ok) return t;
  if (sameTerms(t.terms, termsFieldsOf(plan.close))) return { ok: true, noop: { service: serviceBody(s.value, client, h.terms, lc, today) } };
  const next: Terms = { termsId: uniqueId("FCT", w.terms.map((x) => x.value.termsId)), serviceId: s.value.serviceId, effectiveFrom: plan.effectiveFrom, effectiveUntil: null, ...t.terms };
  const closeRow = (w.terms.find((x) => x.value.termsId === plan.close.termsId) as { recordId: string }).recordId;
  const newHistory = [...h.terms.slice(0, -1), plan.closed, next];
  return {
    ok: true,
    status: 201,
    run: async (txn) => {
      await txn.patch(TABLES.terms, closeRow, termsUntilField(plan.closed.effectiveUntil), termsUntilField(null));
      await txn.create(TABLES.terms, termsCreateFields(next, { orgRecordId: org.recordId, serviceRecordId: s.recordId, ...meta }));
      return {
        events: [
          ev(EVENTS.termsChanged, ENTITY_TERMS, next.termsId, { current: auditTerms(plan.close) }, { closed: auditTerms(plan.closed), next: auditTerms(next) }, `POST /services/${s.value.serviceId}/commercial/changes`, {
            serviceId: s.value.serviceId,
            effectiveFrom: plan.effectiveFrom,
            changedFields: input.req.changedKeys,
          }),
        ],
        body: { service: serviceBody(s.value, client, newHistory, lc, today) },
      };
    },
  };
}
