/**
 * Test-suite copy of the canonical finance/finance-commercial-mapping.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). No changes.
 */
/**
 * Finance commercial setup - storage mapping, PURE (Finance Foundation F3;
 * see TEST-ENV.md "Finance Foundation - F3"). Translates the transitional
 * TEST Airtable rows of "Finance Clients", "Finance Client Services" and
 * "Finance Commercial Terms" to/from the domain in finance-commercial.ts.
 * The rest of the Finance code never sees an Airtable field name.
 *
 * Every stored row is validated on read with the same rules as input; a row
 * that does not validate, links the wrong number of organisations/parents,
 * or duplicates a public id makes the organisation's commercial data
 * INVALID (409) - it is never skipped or guessed.
 *
 * F4 adds "Finance Service Lifecycle" (dated Active / Paused / Ended periods,
 * see finance-lifecycle.ts). Every service must have a valid lifecycle; a
 * service without one is invalid data, never "assumed Active".
 */
import { isIsoDate } from "./finance-effective-dating.ts";
import { isRateBasisPoints, isVatTreatment, type VatTreatment } from "./finance-money.ts";
import { type LifecyclePeriod, checkLifecycle } from "./finance-lifecycle.ts";
import {
  type BillingAddress,
  type BillingMethod,
  type ChargeType,
  type Client,
  type ClientStatus,
  type Frequency,
  type Payer,
  type Service,
  type ServiceStatus,
  type Stored,
  type Terms,
  ID_PATTERNS,
  MAX_BILLABLE_QUANTITY,
  MAX_UNIT_AMOUNT_MINOR,
  checkBillingAddress,
} from "./finance-commercial.ts";

export const TABLES = { clients: "Finance Clients", services: "Finance Client Services", terms: "Finance Commercial Terms", lifecycle: "Finance Service Lifecycle" } as const;

export const F = {
  org: "Organisation",
  revision: "Revision",
  changedBy: "Last Changed By User ID",
  changedAt: "Last Changed At",
  client: {
    id: "Finance Client ID",
    name: "Client Name",
    status: "Status",
    contact: "Billing Contact Name",
    email: "Billing Email",
    cc: "Billing CC Emails",
    terms: "Payment Terms Override (Days)",
    po: "PO Required",
    billingMethod: "Billing Method",
    /** F22 billing address (the Hub's structured address shape). */
    addressLine1: "Billing Address Line 1",
    addressLine2: "Billing Address Line 2",
    townCity: "Billing Town / City",
    county: "Billing County",
    postcode: "Billing Postcode",
    country: "Billing Country",
  },
  service: { id: "Finance Service ID", client: "Client", name: "Service Name", status: "Status" },
  terms: {
    id: "Commercial Terms ID",
    service: "Service",
    from: "Effective From",
    until: "Effective Until",
    payer: "Payer",
    charge: "Charge Type",
    amount: "Amount (Minor Units)",
    vat: "VAT Treatment",
    rate: "VAT Rate (Basis Points)",
    qty: "Default Billable Quantity",
    freq: "Subscription Frequency",
    other: "Other Description",
    createdBy: "Created By User ID",
    createdAt: "Created At",
  },
  lifecycle: {
    id: "Lifecycle ID",
    service: "Service",
    status: "Status",
    from: "Effective From",
    until: "Effective Until",
    supersededBy: "Superseded By",
    reason: "Reason",
    createdBy: "Created By User ID",
    createdAt: "Created At",
  },
} as const;

const CLIENT_STATUS: Record<ClientStatus, string> = { active: "Active", inactive: "Inactive" };
/** Blank = "hub" (the default before F5 added the field); any other stored label is invalid data. */
const BILLING_METHOD: Record<BillingMethod, string> = { hub: "Hub billing", manual: "Manual billing" };
const SERVICE_STATUS: Record<ServiceStatus, string> = { active: "Active", paused: "Paused", ended: "Ended" };
const PAYER: Record<Payer, string> = { client: "Client / school", parent: "Parent / family" };
const CHARGE: Record<ChargeType, string> = { fixed_per_session: "Fixed per delivered session", per_player: "Per player", subscription: "Subscription", other: "Other" };
const VAT: Record<VatTreatment, string> = { plus_vat: "Plus VAT", vat_included: "VAT Included", no_vat: "No VAT" };
const FREQ: Record<Frequency, string> = { weekly: "Weekly", monthly: "Monthly", termly: "Termly" };

function reverse<T extends string>(map: Record<T, string>, label: unknown): T | undefined {
  const name = label && typeof label === "object" && typeof (label as any).name === "string" ? (label as any).name : label;
  return (Object.keys(map) as T[]).find((k) => map[k] === name);
}

export interface Row {
  id: string;
  fields: Record<string, any>;
}

type Parsed<T> = { ok: true; stored: Stored<T>; parent: string | null } | { ok: false; problem: string };

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const links = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
const intOrNull = (v: unknown): number | null | undefined => (v === undefined || v === null || v === "" ? null : typeof v === "number" && Number.isInteger(v) ? v : undefined);
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

function meta(f: Record<string, any>): { revision: number; updatedAt: string | null } | null {
  const rev = intOrNull(f[F.revision]);
  const at = f[F.changedAt];
  if (rev === undefined || rev === null || rev < 1) return null;
  if (at !== undefined && at !== null && typeof at !== "string") return null;
  return { revision: rev, updatedAt: at ?? null };
}

export function clientFromRow(r: Row): Parsed<Client> {
  const f = r.fields ?? {};
  const id = str(f[F.client.id]);
  const name = str(f[F.client.name]);
  const status = reverse(CLIENT_STATUS, f[F.client.status]);
  const email = str(f[F.client.email]);
  const cc = (str(f[F.client.cc]) ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  const terms = intOrNull(f[F.client.terms]);
  const m = meta(f);
  if (!id || !ID_PATTERNS.client.test(id)) return { ok: false, problem: `client row ${r.id}: bad Finance Client ID` };
  if (!name || name.length > 200 || !status || !m) return { ok: false, problem: `client ${id}: name/status/revision invalid` };
  if ((email && !EMAIL_RE.test(email)) || cc.length > 5 || cc.some((e) => !EMAIL_RE.test(e))) return { ok: false, problem: `client ${id}: invalid email` };
  if (terms === undefined || (terms !== null && (terms < 0 || terms > 365))) return { ok: false, problem: `client ${id}: invalid payment terms` };
  const po = f[F.client.po];
  if (po !== undefined && po !== null && typeof po !== "boolean") return { ok: false, problem: `client ${id}: invalid PO Required` };
  const bmRaw = f[F.client.billingMethod];
  const billingMethod = bmRaw === undefined || bmRaw === null || bmRaw === "" ? "hub" : reverse(BILLING_METHOD, bmRaw);
  if (!billingMethod) return { ok: false, problem: `client ${id}: invalid Billing Method` };
  // F22: no address part stored = no billing address; any part stored must make a valid address (never guessed / half-read).
  const addrRaw = { line1: f[F.client.addressLine1], line2: f[F.client.addressLine2], townCity: f[F.client.townCity], county: f[F.client.county], postcode: f[F.client.postcode], country: f[F.client.country] };
  let billingAddress: BillingAddress | null = null;
  if (Object.values(addrRaw).some((v) => str(v) !== null)) {
    const a = checkBillingAddress(Object.fromEntries(Object.entries(addrRaw).map(([k, v]) => [k, str(v)])));
    if (!a.ok || !a.value) return { ok: false, problem: `client ${id}: invalid billing address (${a.ok ? "empty" : a.error})` };
    billingAddress = a.value;
  }
  return {
    ok: true,
    parent: null,
    stored: {
      recordId: r.id,
      value: { clientId: id, name, status, billingContactName: str(f[F.client.contact]), billingEmail: email, billingCcEmails: cc, billingAddress, paymentTermsDaysOverride: terms, poRequired: po === true, billingMethod, ...m },
    },
  };
}

export function serviceFromRow(r: Row): Parsed<Service> {
  const f = r.fields ?? {};
  const id = str(f[F.service.id]);
  const name = str(f[F.service.name]);
  const status = reverse(SERVICE_STATUS, f[F.service.status]);
  const parent = links(f[F.service.client]);
  const m = meta(f);
  if (!id || !ID_PATTERNS.service.test(id)) return { ok: false, problem: `service row ${r.id}: bad Finance Service ID` };
  if (!name || name.length > 200 || !status || !m) return { ok: false, problem: `service ${id}: name/status/revision invalid` };
  if (parent.length !== 1) return { ok: false, problem: `service ${id}: must link exactly one client` };
  return { ok: true, parent: parent[0], stored: { recordId: r.id, value: { serviceId: id, clientId: "", name, status, ...m } } };
}

export function termsFromRow(r: Row): Parsed<Terms> {
  const f = r.fields ?? {};
  const t = F.terms;
  const id = str(f[t.id]);
  const parent = links(f[t.service]);
  const from = f[t.from];
  const until = f[t.until] ?? null;
  const payer = reverse(PAYER, f[t.payer]);
  const charge = reverse(CHARGE, f[t.charge]);
  const vat = reverse(VAT, f[t.vat]);
  const amount = intOrNull(f[t.amount]);
  const rate = intOrNull(f[t.rate]);
  const qty = intOrNull(f[t.qty]);
  const freqLabel = f[t.freq];
  const freq = freqLabel === undefined || freqLabel === null ? null : reverse(FREQ, freqLabel);
  const other = str(f[t.other]);
  if (!id || !ID_PATTERNS.terms.test(id)) return { ok: false, problem: `terms row ${r.id}: bad Commercial Terms ID` };
  const bad = (why: string): Parsed<Terms> => ({ ok: false, problem: `terms ${id}: ${why}` });
  if (parent.length !== 1) return bad("must link exactly one service");
  if (!isIsoDate(from) || (until !== null && !isIsoDate(until))) return bad("invalid effective dates");
  if (!payer || !charge || !vat || !isVatTreatment(vat)) return bad("invalid payer/charge type/VAT treatment");
  if (amount === undefined || amount === null || amount < 0 || amount > MAX_UNIT_AMOUNT_MINOR) return bad("invalid amount");
  if (rate === undefined || rate === null || !isRateBasisPoints(rate) || (vat === "no_vat" && rate !== 0)) return bad("invalid VAT rate");
  if (qty === undefined || (charge === "per_player") !== (qty !== null) || (qty !== null && (qty < 0 || qty > MAX_BILLABLE_QUANTITY))) return bad("invalid default billable quantity");
  if (freq === undefined || (charge === "subscription") !== (freq !== null)) return bad("invalid subscription frequency");
  if ((charge === "other") !== (other !== null) || (other !== null && other.length > 100)) return bad("invalid other description");
  return {
    ok: true,
    parent: parent[0],
    stored: {
      recordId: r.id,
      value: {
        termsId: id,
        serviceId: "",
        effectiveFrom: from as string,
        effectiveUntil: until as string | null,
        payer,
        chargeType: charge,
        amountMinor: amount,
        vatTreatment: vat,
        vatRateBasisPoints: rate,
        defaultBillableQuantity: qty,
        subscriptionFrequency: freq,
        otherDescription: other,
      },
    },
  };
}

export function lifecycleFromRow(r: Row): Parsed<LifecyclePeriod> {
  const f = r.fields ?? {};
  const l = F.lifecycle;
  const id = str(f[l.id]);
  const parent = links(f[l.service]);
  const status = reverse(SERVICE_STATUS, f[l.status]);
  const from = f[l.from] ?? null;
  const until = f[l.until] ?? null;
  const supersededBy = str(f[l.supersededBy]);
  if (!id || !ID_PATTERNS.lifecycle.test(id)) return { ok: false, problem: `lifecycle row ${r.id}: bad Lifecycle ID` };
  if (parent.length !== 1) return { ok: false, problem: `lifecycle ${id}: must link exactly one service` };
  if (!status) return { ok: false, problem: `lifecycle ${id}: invalid status` };
  if ((from !== null && !isIsoDate(from)) || (until !== null && !isIsoDate(until))) return { ok: false, problem: `lifecycle ${id}: invalid effective dates` };
  if (supersededBy !== null && !ID_PATTERNS.lifecycle.test(supersededBy)) return { ok: false, problem: `lifecycle ${id}: invalid Superseded By` };
  return {
    ok: true,
    parent: parent[0],
    stored: { recordId: r.id, value: { lifecycleId: id, serviceId: "", status, effectiveFrom: from, effectiveUntil: until, supersededBy, reason: str(f[l.reason]) } },
  };
}

export interface World {
  clients: Stored<Client>[];
  services: Stored<Service>[];
  terms: Stored<Terms>[];
  lifecycle: Stored<LifecyclePeriod>[];
}

/**
 * All rows already belong to (link) the caller's organisation; a row that
 * links more than one organisation is invalid. Parents are resolved by
 * record id inside this organisation's snapshot only, so a link into
 * another organisation's rows can never resolve.
 */
export function buildWorld(raw: { clients: Row[]; services: Row[]; terms: Row[]; lifecycle?: Row[] }): { ok: true; world: World } | { ok: false; error: string } {
  const problems: string[] = [];
  const lifecycleRows = raw.lifecycle ?? [];
  const multiOrg = (rows: Row[], what: string) => rows.filter((r) => links(r.fields?.[F.org]).length !== 1).forEach((r) => problems.push(`${what} row ${r.id} is linked to more than one organisation`));
  multiOrg(raw.clients, "client");
  multiOrg(raw.services, "service");
  multiOrg(raw.terms, "terms");
  multiOrg(lifecycleRows, "lifecycle");
  const clients: Stored<Client>[] = [];
  for (const r of raw.clients) {
    const p = clientFromRow(r);
    if (p.ok) clients.push(p.stored);
    else problems.push(p.problem);
  }
  const clientByRecord = new Map(clients.map((c) => [c.recordId, c.value.clientId]));
  const services: Stored<Service>[] = [];
  for (const r of raw.services) {
    const p = serviceFromRow(r);
    if (!p.ok) {
      problems.push(p.problem);
      continue;
    }
    const cid = clientByRecord.get(p.parent as string);
    if (!cid) problems.push(`service ${p.stored.value.serviceId} links a client outside this organisation`);
    else services.push({ recordId: p.stored.recordId, value: { ...p.stored.value, clientId: cid } });
  }
  const serviceByRecord = new Map(services.map((s) => [s.recordId, s.value.serviceId]));
  const terms: Stored<Terms>[] = [];
  for (const r of raw.terms) {
    const p = termsFromRow(r);
    if (!p.ok) {
      problems.push(p.problem);
      continue;
    }
    const sid = serviceByRecord.get(p.parent as string);
    if (!sid) problems.push(`terms ${p.stored.value.termsId} links a service outside this organisation`);
    else terms.push({ recordId: p.stored.recordId, value: { ...p.stored.value, serviceId: sid } });
  }
  const lifecycle: Stored<LifecyclePeriod>[] = [];
  for (const r of lifecycleRows) {
    const p = lifecycleFromRow(r);
    if (!p.ok) {
      problems.push(p.problem);
      continue;
    }
    const sid = serviceByRecord.get(p.parent as string);
    if (!sid) problems.push(`lifecycle ${p.stored.value.lifecycleId} links a service outside this organisation`);
    else lifecycle.push({ recordId: p.stored.recordId, value: { ...p.stored.value, serviceId: sid } });
  }
  for (const s of services) {
    const h = checkLifecycle(lifecycle.filter((l) => l.value.serviceId === s.value.serviceId).map((l) => l.value));
    if (!h.ok) problems.push(`service ${s.value.serviceId}: ${h.error}`);
  }
  const dupes = (ids: string[]) => ids.filter((x, i) => ids.indexOf(x) !== i);
  for (const d of [...dupes(clients.map((c) => c.value.clientId)), ...dupes(services.map((s) => s.value.serviceId)), ...dupes(terms.map((t) => t.value.termsId)), ...dupes(lifecycle.map((l) => l.value.lifecycleId))]) problems.push(`duplicate id ${d}`);
  if (problems.length) return { ok: false, error: `Stored commercial setup is not valid (${problems.slice(0, 3).join("; ")}${problems.length > 3 ? `; +${problems.length - 3} more` : ""}) - it must be corrected before use` };
  return { ok: true, world: { clients, services, terms, lifecycle } };
}

// ----- domain -> Airtable fields -----

export function clientFields(c: Client, meta: { userId: string; at: string }, orgRecordId?: string): Record<string, unknown> {
  return {
    ...(orgRecordId ? { [F.org]: [orgRecordId], [F.client.id]: c.clientId } : {}),
    [F.client.name]: c.name,
    [F.client.status]: CLIENT_STATUS[c.status],
    [F.client.contact]: c.billingContactName,
    [F.client.email]: c.billingEmail,
    [F.client.cc]: c.billingCcEmails.length ? c.billingCcEmails.join("\n") : null,
    [F.client.terms]: c.paymentTermsDaysOverride,
    [F.client.po]: c.poRequired,
    [F.client.billingMethod]: BILLING_METHOD[c.billingMethod],
    [F.client.addressLine1]: c.billingAddress?.line1 ?? null,
    [F.client.addressLine2]: c.billingAddress?.line2 ?? null,
    [F.client.townCity]: c.billingAddress?.townCity ?? null,
    [F.client.county]: c.billingAddress?.county ?? null,
    [F.client.postcode]: c.billingAddress?.postcode ?? null,
    [F.client.country]: c.billingAddress?.country ?? null,
    [F.revision]: c.revision,
    [F.changedBy]: meta.userId,
    [F.changedAt]: meta.at,
  };
}

/** Exactly the fields needed to restore a client row to `c` (compensation). */
export function clientRestoreFields(c: Client, previous: Row): Record<string, unknown> {
  return { ...clientFields(c, { userId: previous.fields?.[F.changedBy] ?? null, at: previous.fields?.[F.changedAt] ?? null }) };
}

export function serviceFields(s: Service, meta: { userId: string; at: string }, create?: { orgRecordId: string; clientRecordId: string }): Record<string, unknown> {
  return {
    ...(create ? { [F.org]: [create.orgRecordId], [F.service.id]: s.serviceId, [F.service.client]: [create.clientRecordId] } : {}),
    [F.service.name]: s.name,
    [F.service.status]: SERVICE_STATUS[s.status],
    [F.revision]: s.revision,
    [F.changedBy]: meta.userId,
    [F.changedAt]: meta.at,
  };
}

export function serviceRestoreFields(s: Service, previous: Row): Record<string, unknown> {
  return serviceFields(s, { userId: previous.fields?.[F.changedBy] ?? null, at: previous.fields?.[F.changedAt] ?? null });
}

export function termsCreateFields(t: Terms, create: { orgRecordId: string; serviceRecordId: string; userId: string; at: string }): Record<string, unknown> {
  const x = F.terms;
  return {
    [F.org]: [create.orgRecordId],
    [x.id]: t.termsId,
    [x.service]: [create.serviceRecordId],
    [x.from]: t.effectiveFrom,
    [x.until]: t.effectiveUntil,
    [x.payer]: PAYER[t.payer],
    [x.charge]: CHARGE[t.chargeType],
    [x.amount]: t.amountMinor,
    [x.vat]: VAT[t.vatTreatment],
    [x.rate]: t.vatRateBasisPoints,
    [x.qty]: t.defaultBillableQuantity,
    [x.freq]: t.subscriptionFrequency ? FREQ[t.subscriptionFrequency] : null,
    [x.other]: t.otherDescription,
    [x.createdBy]: create.userId,
    [x.createdAt]: create.at,
  };
}

/** The ONLY edit ever made to an existing terms row: setting (or, as compensation, clearing) its Effective Until. */
export function termsUntilField(until: string | null): Record<string, unknown> {
  return { [F.terms.until]: until };
}

export function lifecycleCreateFields(p: LifecyclePeriod, create: { orgRecordId: string; serviceRecordId: string; userId: string; at: string }): Record<string, unknown> {
  const x = F.lifecycle;
  return {
    [F.org]: [create.orgRecordId],
    [x.id]: p.lifecycleId,
    [x.service]: [create.serviceRecordId],
    [x.status]: SERVICE_STATUS[p.status],
    [x.from]: p.effectiveFrom,
    [x.until]: p.effectiveUntil,
    [x.reason]: p.reason,
    [x.createdBy]: create.userId,
    [x.createdAt]: create.at,
  };
}

/** The only edits ever made to an existing lifecycle row: closing it (Effective Until) or marking it superseded - both reversible only as compensation. */
export function lifecycleUntilField(until: string | null): Record<string, unknown> {
  return { [F.lifecycle.until]: until };
}

export function lifecycleSupersededField(by: string | null): Record<string, unknown> {
  return { [F.lifecycle.supersededBy]: by };
}
