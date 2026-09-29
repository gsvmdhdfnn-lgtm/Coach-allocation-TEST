/**
 * Test-suite copy of the canonical finance/finance-commercial.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). No changes.
 */
/**
 * Finance commercial setup - PURE (Finance Foundation F3; see TEST-ENV.md
 * "Finance Foundation - F3"). Clients, Client Services and effective-dated
 * Commercial Terms. No HTTP, Airtable, Supabase or Deno code.
 *
 * Locked model:
 *   - Finance owns commercial setup; Schedule owns the Session. A Session
 *     may later hold a Finance Service ID and show the read-only summary.
 *   - A Client is the external customer/payer organisation (e.g. a school).
 *     It is NOT the platform tenant (`organisation_id`), which is always the
 *     caller's own profile organisation.
 *   - One Client holds many Services; each Service has its own commercial
 *     terms (payer, charge type, amount, VAT, default billable quantity).
 *   - Terms are effective-dated segments. A change applies from a date
 *     onward: the current segment is closed the day before and a new one is
 *     opened. Earlier segments are never edited; a change may not start
 *     before today or on/before the current segment's start.
 *   - Money is integer pence (F2 kernel); VAT uses F2 treatments/rates; the
 *     Finance Settings default is only a pre-fill.
 *   - F3 never produces per-occurrence expected revenue or Actual Revenue -
 *     only an illustrative amount derived from the terms themselves (F4).
 */
import {
  type Minor,
  type VatTreatment,
  calculateVat,
  formatMinor,
  formatRatePercent,
  isVatTreatment,
  parseMoney,
  parseRatePercent,
} from "./finance-money.ts";
import { type EffectiveDated, entryError, findOverlaps, isIsoDate, resolveEffective } from "./finance-effective-dating.ts";
import { type FinanceSettings, effectiveDefaultVat } from "./finance-settings.ts";

export const COMMERCIAL_CONTRACT = "finance-commercial-v1";

export const ENTITY_CLIENT = "finance_client";
export const ENTITY_SERVICE = "finance_client_service";
export const ENTITY_TERMS = "finance_commercial_terms";
export const EVENTS = {
  clientCreated: "finance_client.created",
  clientUpdated: "finance_client.updated",
  serviceCreated: "finance_client_service.created",
  serviceUpdated: "finance_client_service.updated",
  termsCreated: "finance_commercial_terms.created",
  termsChanged: "finance_commercial_terms.changed",
} as const;

export const REASON_MAX = 500;
/** £100,000 per unit: with the 10,000 quantity cap every product stays inside the F2 MAX_MINOR bound. */
export const MAX_UNIT_AMOUNT_MINOR = 10_000_000;
export const MAX_BILLABLE_QUANTITY = 10_000;

// ---------------------------------------------------------------------
// Vocabulary (public values + plain-language labels)
// ---------------------------------------------------------------------

export const PAYERS = ["client", "parent"] as const;
export type Payer = (typeof PAYERS)[number];
export const PAYER_LABELS: Record<Payer, string> = { client: "Client / school pays", parent: "Parents pay" };

export const CHARGE_TYPES = ["fixed_per_session", "per_player", "subscription", "other"] as const;
export type ChargeType = (typeof CHARGE_TYPES)[number];
export const CHARGE_TYPE_LABELS: Record<ChargeType, string> = {
  fixed_per_session: "Fixed amount per session",
  per_player: "Per player",
  subscription: "Subscription",
  other: "Other",
};

export const FREQUENCIES = ["weekly", "monthly", "termly"] as const;
export type Frequency = (typeof FREQUENCIES)[number];
const FREQUENCY_WORDS: Record<Frequency, string> = { weekly: "week", monthly: "month", termly: "term" };

export const CLIENT_STATUSES = ["active", "inactive"] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];
export const SERVICE_STATUSES = ["active", "paused", "ended"] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

const VAT_LABELS: Record<VatTreatment, string> = { plus_vat: "Plus VAT", vat_included: "VAT included", no_vat: "No VAT" };

// ---------------------------------------------------------------------
// Domain records
// ---------------------------------------------------------------------

export interface Client {
  clientId: string;
  name: string;
  status: ClientStatus;
  billingContactName: string | null;
  billingEmail: string | null;
  billingCcEmails: string[];
  paymentTermsDaysOverride: number | null;
  poRequired: boolean;
  revision: number;
  updatedAt: string | null;
}

export interface Service {
  serviceId: string;
  clientId: string;
  name: string;
  status: ServiceStatus;
  revision: number;
  updatedAt: string | null;
}

export interface TermsFields {
  payer: Payer;
  chargeType: ChargeType;
  amountMinor: Minor;
  vatTreatment: VatTreatment;
  vatRateBasisPoints: number;
  defaultBillableQuantity: number | null;
  subscriptionFrequency: Frequency | null;
  otherDescription: string | null;
}

export interface Terms extends TermsFields {
  termsId: string;
  serviceId: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
}

/** A stored row: the domain value plus the storage record id (never shown publicly). */
export interface Stored<T> {
  recordId: string;
  value: T;
}

// ---------------------------------------------------------------------
// Small validators
// ---------------------------------------------------------------------

export type Invalid = { ok: false; httpStatus: 400; code: string; error: string; fields?: Record<string, string> };
const invalid = (code: string, error: string, fields?: Record<string, string>): Invalid => ({ ok: false, httpStatus: 400, code, error, ...(fields ? { fields } : {}) });

type Check<T> = { ok: true; value: T } | { ok: false; error: string };
const LINE_CONTROL_RE = /[\u0000-\u001F\u007F]/;
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

function text(v: unknown, max: number, required: boolean): Check<string | null> {
  if (v === null || v === undefined) return required ? { ok: false, error: "is required" } : { ok: true, value: null };
  if (typeof v !== "string") return { ok: false, error: "must be text" };
  const s = v.trim();
  if (!s) return required ? { ok: false, error: "is required" } : { ok: true, value: null };
  if (s.length > max) return { ok: false, error: `must be at most ${max} characters` };
  if (LINE_CONTROL_RE.test(s)) return { ok: false, error: "contains control characters" };
  return { ok: true, value: s };
}

function email(v: unknown): Check<string | null> {
  const t = text(v, 254, false);
  if (!t.ok || t.value === null) return t;
  return EMAIL_RE.test(t.value) ? { ok: true, value: t.value.toLowerCase() } : { ok: false, error: "must be a valid email address" };
}

function intIn(v: unknown, min: number, max: number, nullable: boolean): Check<number | null> {
  if (v === null || v === undefined) return nullable ? { ok: true, value: null } : { ok: false, error: "is required" };
  if (typeof v !== "number" || !Number.isInteger(v)) return { ok: false, error: "must be a whole number" };
  if (v < min || v > max) return { ok: false, error: `must be between ${min} and ${max}` };
  return { ok: true, value: v };
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): Check<T> {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? { ok: true, value: v as T } : { ok: false, error: `must be one of ${allowed.join(", ")}` };
}

// ---------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------

export type BodyResult = { ok: true; body: Record<string, unknown>; reason: string | null } | Invalid;

/**
 * Parses a JSON object body with an explicit top-level allowlist. Tenant
 * selectors anywhere at the top level (and in any nested object checked by
 * the section parsers) are 400 tenant_param_rejected; unknown keys 400.
 */
export function parseBody(raw: string, allowedTop: readonly string[], isTenantKey: (k: string) => boolean): BodyResult {
  if (!raw.trim()) return invalid("invalid_body", "Body must be a JSON object");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return invalid("invalid_body", "Body must be valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("invalid_body", "Body must be a JSON object");
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.some(isTenantKey)) return invalid("tenant_param_rejected", "The organisation is taken from your profile and cannot be chosen in the request");
  const unknown = keys.filter((k) => !allowedTop.includes(k));
  if (unknown.length) return invalid("unexpected_field", `Unexpected field(s): ${unknown.join(", ")}`);
  const r = (body as Record<string, unknown>).reason;
  let reason: string | null = null;
  if (r !== undefined && r !== null) {
    if (typeof r !== "string") return invalid("invalid_input", "reason must be text", { reason: "must be text" });
    const t = r.trim();
    if (t.length > REASON_MAX) return invalid("invalid_input", `reason must be at most ${REASON_MAX} characters`, { reason: `must be at most ${REASON_MAX} characters` });
    if (LINE_CONTROL_RE.test(t.replace(/\n/g, " "))) return invalid("invalid_input", "reason contains control characters", { reason: "contains control characters" });
    reason = t || null;
  }
  return { ok: true, body: body as Record<string, unknown>, reason };
}

type Section = { ok: true; value: Record<string, unknown>; keys: string[] } | Invalid;

function section(v: unknown, name: string, allowed: readonly string[], isTenantKey: (k: string) => boolean, requireNonEmpty: boolean): Section {
  if (!v || typeof v !== "object" || Array.isArray(v)) return invalid("invalid_body", `${name} must be an object`);
  const keys = Object.keys(v as Record<string, unknown>);
  if (keys.some(isTenantKey)) return invalid("tenant_param_rejected", "The organisation is taken from your profile and cannot be chosen in the request");
  const unknown = keys.filter((k) => !allowed.includes(k));
  if (unknown.length) return invalid("unexpected_field", `Unknown ${name} field(s): ${unknown.join(", ")}`);
  if (requireNonEmpty && !keys.length) return invalid("invalid_body", `${name} must name at least one field`);
  return { ok: true, value: v as Record<string, unknown>, keys };
}

// ----- Clients -----

export const CLIENT_FIELDS = ["name", "status", "billingContactName", "billingEmail", "billingCcEmails", "paymentTermsDaysOverride", "poRequired"] as const;
export type ClientPatch = Partial<Omit<Client, "clientId" | "revision" | "updatedAt">>;

function clientField(k: string, v: unknown): Check<unknown> {
  switch (k) {
    case "name":
      return text(v, 200, true);
    case "status":
      return oneOf(v, CLIENT_STATUSES);
    case "billingContactName":
      return text(v, 200, false);
    case "billingEmail":
      return email(v);
    case "billingCcEmails": {
      if (v === null) return { ok: true, value: [] };
      if (!Array.isArray(v) || v.length > 5) return { ok: false, error: "must be a list of at most 5 email addresses" };
      const out: string[] = [];
      for (const e of v) {
        const r = email(e);
        if (!r.ok || r.value === null) return { ok: false, error: "must contain only valid email addresses" };
        if (!out.includes(r.value)) out.push(r.value);
      }
      return { ok: true, value: out };
    }
    case "paymentTermsDaysOverride":
      return intIn(v, 0, 365, true);
    case "poRequired":
      return typeof v === "boolean" ? { ok: true, value: v } : { ok: false, error: "must be true or false" };
  }
  return { ok: false, error: "is not a client field" };
}

function collect(sec: { value: Record<string, unknown>; keys: string[] }, check: (k: string, v: unknown) => Check<unknown>): { ok: true; patch: Record<string, unknown> } | Invalid {
  const patch: Record<string, unknown> = {};
  const fields: Record<string, string> = {};
  for (const k of sec.keys) {
    const r = check(k, sec.value[k]);
    if (r.ok) patch[k] = r.value;
    else fields[k] = r.error;
  }
  if (Object.keys(fields).length) return invalid("invalid_input", "Some fields are not valid - nothing was saved", fields);
  return { ok: true, patch };
}

export function parseClientCreate(raw: string, isTenantKey: (k: string) => boolean): { ok: true; client: ClientPatch & { name: string }; reason: string | null } | Invalid {
  const b = parseBody(raw, ["client", "reason"], isTenantKey);
  if (!b.ok) return b;
  const s = section(b.body.client, "client", CLIENT_FIELDS, isTenantKey, true);
  if (!s.ok) return s;
  const c = collect(s, clientField);
  if (!c.ok) return c;
  if (typeof c.patch.name !== "string") return invalid("invalid_input", "Some fields are not valid - nothing was saved", { name: "is required" });
  return { ok: true, client: c.patch as ClientPatch & { name: string }, reason: b.reason };
}

export function parseClientUpdate(raw: string, isTenantKey: (k: string) => boolean): { ok: true; patch: ClientPatch; reason: string | null } | Invalid {
  const b = parseBody(raw, ["client", "reason"], isTenantKey);
  if (!b.ok) return b;
  const s = section(b.body.client, "client", CLIENT_FIELDS, isTenantKey, true);
  if (!s.ok) return s;
  const c = collect(s, clientField);
  if (!c.ok) return c;
  return { ok: true, patch: c.patch as ClientPatch, reason: b.reason };
}

export function newClient(id: string, input: ClientPatch & { name: string }): Client {
  return {
    clientId: id,
    name: input.name,
    status: input.status ?? "active",
    billingContactName: input.billingContactName ?? null,
    billingEmail: input.billingEmail ?? null,
    billingCcEmails: input.billingCcEmails ?? [],
    paymentTermsDaysOverride: input.paymentTermsDaysOverride ?? null,
    poRequired: input.poRequired ?? false,
    revision: 1,
    updatedAt: null,
  };
}

// ----- Services -----

export const SERVICE_FIELDS = ["name", "status"] as const;
export type ServicePatch = Partial<Pick<Service, "name" | "status">>;

function serviceField(k: string, v: unknown): Check<unknown> {
  if (k === "name") return text(v, 200, true);
  if (k === "status") return oneOf(v, SERVICE_STATUSES);
  return { ok: false, error: "is not a service field" };
}

export const TERMS_INPUT_FIELDS = ["payer", "chargeType", "amount", "vatTreatment", "vatRatePercent", "defaultBillableQuantity", "subscriptionFrequency", "otherDescription"] as const;
export type TermsInput = Partial<{
  payer: Payer;
  chargeType: ChargeType;
  amountMinor: Minor;
  vatTreatment: VatTreatment;
  vatRateBasisPoints: number;
  defaultBillableQuantity: number | null;
  subscriptionFrequency: Frequency | null;
  otherDescription: string | null;
}>;

function termsField(k: string, v: unknown): Check<[string, unknown]> {
  switch (k) {
    case "payer": {
      const r = oneOf(v, PAYERS);
      return r.ok ? { ok: true, value: ["payer", r.value] } : r;
    }
    case "chargeType": {
      const r = oneOf(v, CHARGE_TYPES);
      return r.ok ? { ok: true, value: ["chargeType", r.value] } : r;
    }
    case "amount": {
      const m = parseMoney(v);
      if (!m.ok) return { ok: false, error: m.error };
      if (m.minor < 0) return { ok: false, error: "must not be negative" };
      if (m.minor > MAX_UNIT_AMOUNT_MINOR) return { ok: false, error: "must be at most 100000.00" };
      return { ok: true, value: ["amountMinor", m.minor] };
    }
    case "vatTreatment":
      return isVatTreatment(v) ? { ok: true, value: ["vatTreatment", v] } : { ok: false, error: "must be one of plus_vat, vat_included, no_vat" };
    case "vatRatePercent": {
      const r = parseRatePercent(v);
      return r.ok ? { ok: true, value: ["vatRateBasisPoints", r.basisPoints] } : { ok: false, error: r.error };
    }
    case "defaultBillableQuantity": {
      const r = intIn(v, 0, MAX_BILLABLE_QUANTITY, true);
      return r.ok ? { ok: true, value: ["defaultBillableQuantity", r.value] } : r;
    }
    case "subscriptionFrequency": {
      if (v === null) return { ok: true, value: ["subscriptionFrequency", null] };
      const r = oneOf(v, FREQUENCIES);
      return r.ok ? { ok: true, value: ["subscriptionFrequency", r.value] } : r;
    }
    case "otherDescription": {
      const r = text(v, 100, false);
      return r.ok ? { ok: true, value: ["otherDescription", r.value] } : r;
    }
  }
  return { ok: false, error: "is not a commercial field" };
}

function collectTerms(sec: { value: Record<string, unknown>; keys: string[] }): { ok: true; input: TermsInput } | Invalid {
  const input: Record<string, unknown> = {};
  const fields: Record<string, string> = {};
  for (const k of sec.keys) {
    const r = termsField(k, sec.value[k]);
    if (r.ok) input[r.value[0]] = r.value[1];
    else fields[k] = r.error;
  }
  if (Object.keys(fields).length) return invalid("invalid_input", "Some commercial fields are not valid - nothing was saved", fields);
  return { ok: true, input: input as TermsInput };
}

export type InitialTermsRequest = { effectiveFrom: string; input: TermsInput };

function initialTerms(v: unknown, isTenantKey: (k: string) => boolean): { ok: true; req: InitialTermsRequest } | Invalid {
  const s = section(v, "commercial", ["effectiveFrom", ...TERMS_INPUT_FIELDS], isTenantKey, true);
  if (!s.ok) return s;
  const from = s.value.effectiveFrom;
  const rest = { value: s.value, keys: s.keys.filter((k) => k !== "effectiveFrom") };
  const t = collectTerms(rest);
  const fields: Record<string, string> = t.ok ? {} : { ...(t.fields ?? {}) };
  if (!isIsoDate(from)) fields.effectiveFrom = "must be a real date YYYY-MM-DD";
  for (const req of ["payer", "chargeType", "amount"]) if (!s.keys.includes(req)) fields[req] = "is required";
  if (Object.keys(fields).length) return invalid("invalid_input", "Some commercial fields are not valid - nothing was saved", fields);
  return { ok: true, req: { effectiveFrom: from as string, input: (t as { ok: true; input: TermsInput }).input } };
}

export function parseServiceCreate(raw: string, isTenantKey: (k: string) => boolean): { ok: true; name: string; initial: InitialTermsRequest | null; reason: string | null } | Invalid {
  const b = parseBody(raw, ["service", "commercial", "reason"], isTenantKey);
  if (!b.ok) return b;
  const s = section(b.body.service, "service", ["name"], isTenantKey, true);
  if (!s.ok) return s;
  const c = collect(s, serviceField);
  if (!c.ok) return c;
  let initial: InitialTermsRequest | null = null;
  if (b.body.commercial !== undefined) {
    const t = initialTerms(b.body.commercial, isTenantKey);
    if (!t.ok) return t;
    initial = t.req;
  }
  return { ok: true, name: c.patch.name as string, initial, reason: b.reason };
}

export function parseServiceUpdate(raw: string, isTenantKey: (k: string) => boolean): { ok: true; patch: ServicePatch; reason: string | null } | Invalid {
  const b = parseBody(raw, ["service", "reason"], isTenantKey);
  if (!b.ok) return b;
  const s = section(b.body.service, "service", SERVICE_FIELDS, isTenantKey, true);
  if (!s.ok) return s;
  const c = collect(s, serviceField);
  if (!c.ok) return c;
  return { ok: true, patch: c.patch as ServicePatch, reason: b.reason };
}

export function parseInitialTerms(raw: string, isTenantKey: (k: string) => boolean): { ok: true; req: InitialTermsRequest; reason: string | null } | Invalid {
  const b = parseBody(raw, ["commercial", "reason"], isTenantKey);
  if (!b.ok) return b;
  const t = initialTerms(b.body.commercial, isTenantKey);
  if (!t.ok) return t;
  return { ok: true, req: t.req, reason: b.reason };
}

export type ChangeRequest = { effectiveFrom: string; changes: TermsInput; changedKeys: string[] };

export function parseTermsChange(raw: string, isTenantKey: (k: string) => boolean): { ok: true; req: ChangeRequest; reason: string | null } | Invalid {
  const b = parseBody(raw, ["effectiveFrom", "changes", "reason"], isTenantKey);
  if (!b.ok) return b;
  const s = section(b.body.changes, "changes", TERMS_INPUT_FIELDS, isTenantKey, true);
  if (!s.ok) return s;
  const t = collectTerms(s);
  const fields: Record<string, string> = t.ok ? {} : { ...(t.fields ?? {}) };
  if (!isIsoDate(b.body.effectiveFrom)) fields.effectiveFrom = "must be a real date YYYY-MM-DD";
  if (Object.keys(fields).length) return invalid("invalid_input", "Some commercial fields are not valid - nothing was saved", fields);
  return { ok: true, req: { effectiveFrom: b.body.effectiveFrom as string, changes: (t as { ok: true; input: TermsInput }).input, changedKeys: s.keys }, reason: b.reason };
}

// ---------------------------------------------------------------------
// Completing / validating terms (VAT defaults from Finance Settings)
// ---------------------------------------------------------------------

export type TermsResult = { ok: true; terms: TermsFields } | Invalid;

/**
 * Builds complete terms from `input` on top of `base` (the current terms for
 * a change, or nothing for a new setup). Rules:
 *   - per_player needs a default billable quantity; other types carry none
 *     (an inherited quantity is dropped, an explicitly supplied one refused);
 *   - subscription needs a frequency; "other" needs a short description;
 *   - VAT treatment/rate: explicit input first, else the previous terms, else
 *     the Finance Settings default (pre-fill only); no_vat always has rate 0;
 *     an organisation recorded as not VAT registered can only use no_vat.
 */
export function completeTerms(input: TermsInput, base: TermsFields | null, settings: FinanceSettings | null): TermsResult {
  const fields: Record<string, string> = {};
  const has = (k: keyof TermsInput) => Object.prototype.hasOwnProperty.call(input, k);
  const payer = input.payer ?? base?.payer;
  const chargeType = input.chargeType ?? base?.chargeType;
  const amountMinor = input.amountMinor ?? base?.amountMinor;
  if (!payer) fields.payer = "is required";
  if (!chargeType) fields.chargeType = "is required";
  if (amountMinor === undefined) fields.amount = "is required";

  let quantity: number | null = null;
  let frequency: Frequency | null = null;
  let description: string | null = null;
  if (chargeType === "per_player") {
    quantity = has("defaultBillableQuantity") ? (input.defaultBillableQuantity ?? null) : (base?.chargeType === "per_player" ? base.defaultBillableQuantity : null);
    if (quantity === null) fields.defaultBillableQuantity = "is required for per-player charging";
  } else if (has("defaultBillableQuantity") && input.defaultBillableQuantity !== null) {
    fields.defaultBillableQuantity = "only applies to per-player charging";
  }
  if (chargeType === "subscription") {
    frequency = has("subscriptionFrequency") ? (input.subscriptionFrequency ?? null) : (base?.chargeType === "subscription" ? base.subscriptionFrequency : null);
    if (frequency === null) fields.subscriptionFrequency = "is required for a subscription";
  } else if (has("subscriptionFrequency") && input.subscriptionFrequency !== null) {
    fields.subscriptionFrequency = "only applies to a subscription";
  }
  if (chargeType === "other") {
    description = has("otherDescription") ? (input.otherDescription ?? null) : (base?.chargeType === "other" ? base.otherDescription : null);
    if (description === null) fields.otherDescription = "is required for other charging (e.g. \"per term fee\")";
  } else if (has("otherDescription") && input.otherDescription !== null) {
    fields.otherDescription = "only applies to other charging";
  }

  const settingsVat = settings ? effectiveDefaultVat(settings) : null;
  const treatment: VatTreatment | undefined = input.vatTreatment ?? base?.vatTreatment ?? settingsVat?.treatment;
  let rate: number | undefined;
  if (!treatment) {
    fields.vatTreatment = "is required (no Finance Settings default is configured)";
  } else if (treatment === "no_vat") {
    if (has("vatRateBasisPoints") && input.vatRateBasisPoints !== 0) fields.vatRatePercent = "must be empty or 0 when there is no VAT";
    rate = 0;
  } else {
    rate = has("vatRateBasisPoints")
      ? input.vatRateBasisPoints
      : base && base.vatTreatment !== "no_vat"
        ? base.vatRateBasisPoints
        : settingsVat && settingsVat.treatment !== "no_vat"
          ? settingsVat.rateBasisPoints
          : settings?.defaultVatRateBasisPoints ?? undefined;
    if (rate === undefined || rate === null) fields.vatRatePercent = "is required (no Finance Settings default rate is configured)";
    if (settings?.vatRegistered === false) fields.vatTreatment = "must be no_vat - the organisation is recorded as not VAT registered";
  }
  if (Object.keys(fields).length) return invalid("invalid_input", "The commercial setup is not complete or not consistent - nothing was saved", fields);
  return {
    ok: true,
    terms: {
      payer: payer as Payer,
      chargeType: chargeType as ChargeType,
      amountMinor: amountMinor as Minor,
      vatTreatment: treatment as VatTreatment,
      vatRateBasisPoints: rate as number,
      defaultBillableQuantity: quantity,
      subscriptionFrequency: frequency,
      otherDescription: description,
    },
  };
}

export function sameTerms(a: TermsFields, b: TermsFields): boolean {
  return (
    a.payer === b.payer &&
    a.chargeType === b.chargeType &&
    a.amountMinor === b.amountMinor &&
    a.vatTreatment === b.vatTreatment &&
    a.vatRateBasisPoints === b.vatRateBasisPoints &&
    a.defaultBillableQuantity === b.defaultBillableQuantity &&
    a.subscriptionFrequency === b.subscriptionFrequency &&
    a.otherDescription === b.otherDescription
  );
}

export function termsFieldsOf(t: Terms): TermsFields {
  return {
    payer: t.payer,
    chargeType: t.chargeType,
    amountMinor: t.amountMinor,
    vatTreatment: t.vatTreatment,
    vatRateBasisPoints: t.vatRateBasisPoints,
    defaultBillableQuantity: t.defaultBillableQuantity,
    subscriptionFrequency: t.subscriptionFrequency,
    otherDescription: t.otherDescription,
  };
}

// ---------------------------------------------------------------------
// Effective-dated history (reuses the F2 effective-dating helper)
// ---------------------------------------------------------------------

const asDated = (t: Terms): EffectiveDated<Terms> => ({ effectiveFrom: t.effectiveFrom, effectiveUntil: t.effectiveUntil, value: t });

export type HistoryCheck = { ok: true; history: Terms[] } | { ok: false; code: "commercial_terms_invalid" | "commercial_terms_overlap"; error: string };

/** Sorted, well-formed, non-overlapping, and only the latest segment may be open-ended. Anything else is a configuration error. */
export function checkHistory(terms: readonly Terms[]): HistoryCheck {
  for (const t of terms) {
    const e = entryError(asDated(t));
    if (e) return { ok: false, code: "commercial_terms_invalid", error: `Commercial terms ${t.termsId}: ${e}` };
  }
  const sorted = [...terms].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0));
  const overlaps = findOverlaps(sorted.map(asDated));
  if (overlaps.length) {
    const [i, j] = overlaps[0];
    return { ok: false, code: "commercial_terms_overlap", error: `Commercial terms ${sorted[i].termsId} and ${sorted[j].termsId} overlap - the setup must be corrected before use` };
  }
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].effectiveUntil === null) return { ok: false, code: "commercial_terms_invalid", error: `Commercial terms ${sorted[i].termsId} is open-ended but is not the latest` };
  }
  return { ok: true, history: sorted };
}

export type TermsOnDate = { status: "resolved"; terms: Terms } | { status: "none" } | { status: "ambiguous" } | { status: "invalid"; error: string };

export function termsOn(history: readonly Terms[], dateIso: string): TermsOnDate {
  const r = resolveEffective(history.map(asDated), dateIso);
  if (r.status === "resolved") return { status: "resolved", terms: r.entry.value };
  if (r.status === "ambiguous") return { status: "ambiguous" };
  if (r.status === "invalid") return { status: "invalid", error: r.error };
  return { status: "none" };
}

/** YYYY-MM-DD minus one day (pure calendar arithmetic, UTC). */
export function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** The calendar date "now" in the organisation's timezone. */
export function todayIn(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export type ChangePlan =
  | { ok: true; close: Terms; closed: Terms; effectiveFrom: string }
  | { ok: false; httpStatus: 409; code: string; error: string };

/**
 * An effective-dated change never rewrites what already applied: it must
 * start today or later AND after the start of the current (latest, open)
 * segment. The latest segment is closed on the day before; nothing earlier
 * is touched.
 */
export function planChange(history: readonly Terms[], effectiveFrom: string, today: string): ChangePlan {
  if (!history.length) return { ok: false, httpStatus: 409, code: "commercial_terms_missing", error: "This service has no commercial setup yet - create it first" };
  const latest = history[history.length - 1];
  if (latest.effectiveUntil !== null) return { ok: false, httpStatus: 409, code: "commercial_terms_invalid", error: "The latest commercial terms are closed - the setup must be corrected before use" };
  if (effectiveFrom < today) return { ok: false, httpStatus: 409, code: "backdated_change_not_allowed", error: `A change cannot apply from ${effectiveFrom}: changes apply from today (${today}) onward and never rewrite earlier periods` };
  if (effectiveFrom <= latest.effectiveFrom) return { ok: false, httpStatus: 409, code: "change_overlaps_current_terms", error: `A change must start after the current terms began (${latest.effectiveFrom})` };
  return { ok: true, close: latest, closed: { ...latest, effectiveUntil: dayBefore(effectiveFrom) }, effectiveFrom };
}

// ---------------------------------------------------------------------
// Plain-language summary + illustrative amount
// ---------------------------------------------------------------------

/** 5000 -> "£50", 950 -> "£9.50", 125000 -> "£1,250". */
export function formatGBP(minor: Minor): string {
  const [major, pence] = formatMinor(minor).replace("-", "").split(".");
  const grouped = major.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${minor < 0 ? "-" : ""}£${grouped}${pence === "00" ? "" : `.${pence}`}`;
}

function vatSuffix(t: VatTreatment): string {
  return t === "plus_vat" ? " + VAT" : t === "vat_included" ? " inc. VAT" : "";
}

/** The Management-facing one-liner, e.g. "£50 + VAT per delivered session", "£9 per player · 18 billable · £162 expected per session". */
export function describeTerms(t: TermsFields): string {
  const amt = `${formatGBP(t.amountMinor)}${vatSuffix(t.vatTreatment)}`;
  switch (t.chargeType) {
    case "fixed_per_session":
      return `${amt} per delivered session`;
    case "per_player": {
      const q = t.defaultBillableQuantity ?? 0;
      return `${amt} per player · ${q} billable · ${formatGBP(t.amountMinor * q)}${vatSuffix(t.vatTreatment)} expected per session`;
    }
    case "subscription":
      return `${amt} per ${FREQUENCY_WORDS[t.subscriptionFrequency as Frequency]}`;
    case "other":
      return `${amt} · ${t.otherDescription}`;
  }
}

/**
 * The illustrative amount implied by the terms alone (per delivered session,
 * per session at the default quantity, per subscription period, or per
 * charge) with its VAT breakdown from the F2 kernel. This is NOT expected
 * revenue for any occurrence (F4) and never Actual Revenue.
 */
export function illustrate(t: TermsFields): { basis: string; amount: string; net: string; vat: string; gross: string } | null {
  const units = t.chargeType === "per_player" ? (t.defaultBillableQuantity ?? 0) : 1;
  const r = calculateVat({ amountMinor: t.amountMinor * units, treatment: t.vatTreatment, rateBasisPoints: t.vatTreatment === "no_vat" ? null : t.vatRateBasisPoints });
  if (!r.ok) return null;
  const basis =
    t.chargeType === "fixed_per_session" ? "per delivered session" : t.chargeType === "per_player" ? `per session at ${units} billable` : t.chargeType === "subscription" ? `per ${FREQUENCY_WORDS[t.subscriptionFrequency as Frequency]}` : "per charge";
  return { basis, amount: formatMinor(t.amountMinor * units), net: formatMinor(r.netMinor), vat: formatMinor(r.vatMinor), gross: formatMinor(r.grossMinor) };
}

// ---------------------------------------------------------------------
// Public bodies (no storage ids, no user ids, no audit internals)
// ---------------------------------------------------------------------

export function publicClient(c: Client) {
  return {
    clientId: c.clientId,
    name: c.name,
    status: c.status,
    billingContactName: c.billingContactName,
    billingEmail: c.billingEmail,
    billingCcEmails: [...c.billingCcEmails],
    paymentTermsDaysOverride: c.paymentTermsDaysOverride,
    poRequired: c.poRequired,
    revision: c.revision,
    updatedAt: c.updatedAt,
  };
}

export function publicTerms(t: Terms, today: string) {
  const period = t.effectiveFrom > today ? "upcoming" : t.effectiveUntil !== null && t.effectiveUntil < today ? "past" : "current";
  return {
    termsId: t.termsId,
    effectiveFrom: t.effectiveFrom,
    effectiveUntil: t.effectiveUntil,
    period,
    payer: t.payer,
    payerLabel: PAYER_LABELS[t.payer],
    chargeType: t.chargeType,
    chargeTypeLabel: CHARGE_TYPE_LABELS[t.chargeType],
    amount: formatMinor(t.amountMinor),
    vatTreatment: t.vatTreatment,
    vatLabel: VAT_LABELS[t.vatTreatment],
    vatRatePercent: formatRatePercent(t.vatRateBasisPoints),
    defaultBillableQuantity: t.defaultBillableQuantity,
    subscriptionFrequency: t.subscriptionFrequency,
    otherDescription: t.otherDescription,
    summary: describeTerms(t),
    illustrativeAmount: illustrate(t),
  };
}

export function publicService(s: Service, client: Client, history: readonly Terms[], today: string, onDate?: string) {
  const current = termsOn(history, today);
  const body: Record<string, unknown> = {
    serviceId: s.serviceId,
    clientId: client.clientId,
    clientName: client.name,
    name: s.name,
    status: s.status,
    revision: s.revision,
    updatedAt: s.updatedAt,
    commercial: {
      configured: history.length > 0,
      today,
      current: current.status === "resolved" ? publicTerms(current.terms, today) : null,
      history: history.map((t) => publicTerms(t, today)),
    },
  };
  if (onDate !== undefined) {
    const on = termsOn(history, onDate);
    (body.commercial as Record<string, unknown>).onDate = { date: onDate, terms: on.status === "resolved" ? publicTerms(on.terms, today) : null };
  }
  return body;
}

// ---------------------------------------------------------------------
// Audit events (F2 Finance audit trail contract)
// ---------------------------------------------------------------------

export interface AuditEvent {
  organisation_id: string;
  actor_user_id: string;
  event_type: string;
  entity_type: string;
  record_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  reason: string | null;
  context: Record<string, unknown>;
}

export function auditEvent(a: {
  organisationId: string;
  actorUserId: string;
  eventType: string;
  entityType: string;
  recordId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  reason: string | null;
  route: string;
  context?: Record<string, unknown>;
}): AuditEvent {
  return {
    organisation_id: a.organisationId,
    actor_user_id: a.actorUserId,
    event_type: a.eventType,
    entity_type: a.entityType,
    record_id: a.recordId,
    before: a.before,
    after: a.after,
    reason: a.reason,
    context: { source: "finance-api", contract: COMMERCIAL_CONTRACT, route: a.route, ...(a.context ?? {}) },
  };
}

export function auditTerms(t: Terms): Record<string, unknown> {
  return { termsId: t.termsId, serviceId: t.serviceId, effectiveFrom: t.effectiveFrom, effectiveUntil: t.effectiveUntil, ...termsFieldsOf(t) };
}

// ---------------------------------------------------------------------
// Routes + opaque ids
// ---------------------------------------------------------------------

export const ID_PATTERNS = { client: /^FCL-[0-9A-F]{12}$/, service: /^FSV-[0-9A-F]{12}$/, terms: /^FCT-[0-9A-F]{12}$/ } as const;

export function newId(prefix: "FCL" | "FSV" | "FCT", randomHex: string): string {
  return `${prefix}-${randomHex.replace(/[^0-9a-f]/gi, "").slice(0, 12).toUpperCase()}`;
}

export type CommercialRoute =
  | { name: "clients.list" | "clients.create" | "options"; params: Record<string, never> }
  | { name: "client.read" | "client.update" | "services.create"; params: { clientId: string } }
  | { name: "service.read" | "service.update" | "terms.create" | "terms.change"; params: { serviceId: string } };

type Match = { status: "match"; route: CommercialRoute; queryAllowed: string[] } | { status: "method"; allowed: string[] } | { status: "not_found" } | null;

/** Matches the F3 paths (null = not an F3 path). Ids must be well-formed; a malformed id is 404. */
export function matchCommercialRoute(path: string, method: string): Match {
  const seg = path.split("/");
  const m = (allowed: string[], build: () => { route: CommercialRoute; queryAllowed?: string[] } | null): Match => {
    if (!allowed.includes(method)) return { status: "method", allowed };
    const r = build();
    return r ? { status: "match", route: r.route, queryAllowed: r.queryAllowed ?? [] } : { status: "not_found" };
  };
  if (seg[0] === "clients") {
    if (seg.length === 1) return m(["GET", "POST"], () => ({ route: { name: method === "GET" ? "clients.list" : "clients.create", params: {} } }));
    if (!ID_PATTERNS.client.test(seg[1])) return { status: "not_found" };
    const clientId = seg[1];
    if (seg.length === 2) return m(["GET", "POST"], () => ({ route: { name: method === "GET" ? "client.read" : "client.update", params: { clientId } } }));
    if (seg.length === 3 && seg[2] === "services") return m(["POST"], () => ({ route: { name: "services.create", params: { clientId } } }));
    return { status: "not_found" };
  }
  if (seg[0] === "services") {
    if (seg.length < 2 || !ID_PATTERNS.service.test(seg[1])) return { status: "not_found" };
    const serviceId = seg[1];
    if (seg.length === 2) return m(["GET", "POST"], () => ({ route: { name: method === "GET" ? "service.read" : "service.update", params: { serviceId } }, queryAllowed: method === "GET" ? ["on"] : [] }));
    if (seg.length === 3 && seg[2] === "commercial") return m(["POST"], () => ({ route: { name: "terms.create", params: { serviceId } } }));
    if (seg.length === 4 && seg[2] === "commercial" && seg[3] === "changes") return m(["POST"], () => ({ route: { name: "terms.change", params: { serviceId } } }));
    return { status: "not_found" };
  }
  if (seg[0] === "commercial" && seg.length === 2 && seg[1] === "options") return m(["GET"], () => ({ route: { name: "options", params: {} } }));
  return null;
}

/** Query keys: tenant selectors 400 tenant_param_rejected; anything not allowed for the route 400 unexpected_parameter; `on` must be a real date. */
export function checkCommercialQuery(params: URLSearchParams, allowed: readonly string[], isTenantKey: (k: string) => boolean): { ok: true; on?: string } | Invalid {
  const keys = [...params.keys()];
  if (keys.some(isTenantKey)) return invalid("tenant_param_rejected", "The organisation is taken from your profile and cannot be chosen in the request");
  const bad = keys.filter((k) => !allowed.includes(k));
  if (bad.length) return invalid("unexpected_parameter", `Unexpected query parameter(s): ${bad.join(", ")}`);
  if (params.getAll("on").length > 1) return invalid("unexpected_parameter", "on may be given once");
  const on = params.get("on");
  if (on !== null && !isIsoDate(on)) return invalid("invalid_input", "on must be a real date YYYY-MM-DD", { on: "must be a real date YYYY-MM-DD" });
  return on === null ? { ok: true } : { ok: true, on };
}
