/**
 * Finance Settings domain - PURE (Finance Foundation F2; see TEST-ENV.md
 * "Finance Foundation - F2"). No HTTP, Airtable, Supabase or Deno code:
 * validation, merging, completeness, stored-field mapping, the public
 * response and the audit event are plain functions over loaded data, so a
 * later storage move (Airtable -> Supabase) only replaces the repository.
 *
 * Scope (locked): the Finance-specific settings of ONE organisation -
 *   - invoice identity NOT already owned by Organisation & Branding
 *     (legal name, invoice address, company number; the trading name,
 *     logo, website and support email stay in Organisation & Branding);
 *   - VAT: registration state, VAT number, default rate, default treatment
 *     (a default only - per-service treatment arrives in F3);
 *   - default payment terms (days);
 *   - Coach payment rule: day N (1-31) of the month after the work; in a
 *     shorter month it resolves to that month's last day (see
 *     resolveCoachPaymentDate). The stored day itself never changes.
 * Optional integrations (Stripe / Xero / Sheets) are not settings here and
 * never affect completeness. No credentials are stored.
 */
import { type VatTreatment, VAT_TREATMENTS, isRateBasisPoints, isVatTreatment } from "./finance-money.ts";

export const SETTINGS_CONTRACT = "finance-settings-v1";
export const SETTINGS_ENTITY_TYPE = "finance_settings";
export const SETTINGS_EVENT_CREATED = "finance_settings.created";
export const SETTINGS_EVENT_UPDATED = "finance_settings.updated";
export const REASON_MAX = 500;

export const SETTINGS_KEYS = [
  "invoiceLegalName",
  "invoiceAddress",
  "companyNumber",
  "vatRegistered",
  "vatNumber",
  "defaultVatRateBasisPoints",
  "defaultVatTreatment",
  "defaultPaymentTermsDays",
  "coachPaymentDayOfFollowingMonth",
] as const;
export type SettingsKey = (typeof SETTINGS_KEYS)[number];

export interface FinanceSettings {
  invoiceLegalName: string | null;
  invoiceAddress: string | null;
  companyNumber: string | null;
  vatRegistered: boolean | null;
  vatNumber: string | null;
  defaultVatRateBasisPoints: number | null;
  defaultVatTreatment: VatTreatment | null;
  defaultPaymentTermsDays: number | null;
  coachPaymentDayOfFollowingMonth: number | null;
}

export const EMPTY_SETTINGS: FinanceSettings = Object.freeze({
  invoiceLegalName: null,
  invoiceAddress: null,
  companyNumber: null,
  vatRegistered: null,
  vatNumber: null,
  defaultVatRateBasisPoints: null,
  defaultVatTreatment: null,
  defaultPaymentTermsDays: null,
  coachPaymentDayOfFollowingMonth: null,
});

// ---------------------------------------------------------------------
// Transitional Airtable storage mapping (TEST table "Finance Settings")
// ---------------------------------------------------------------------

export const SETTINGS_TABLE = "Finance Settings";
export const STORED = {
  id: "Finance Settings ID",
  organisation: "Organisation",
  revision: "Revision",
  changedBy: "Last Changed By User ID",
  changedAt: "Last Changed At",
} as const;

export const FIELD_NAMES: Record<SettingsKey, string> = {
  invoiceLegalName: "Invoice Legal Name",
  invoiceAddress: "Invoice Address",
  companyNumber: "Company Number",
  vatRegistered: "VAT Registration",
  vatNumber: "VAT Number",
  defaultVatRateBasisPoints: "Default VAT Rate (Basis Points)",
  defaultVatTreatment: "Default VAT Treatment",
  defaultPaymentTermsDays: "Default Payment Terms (Days)",
  coachPaymentDayOfFollowingMonth: "Coach Payment Day",
};

const VAT_REGISTRATION_CHOICES = { registered: "Registered", notRegistered: "Not registered" } as const;
const TREATMENT_CHOICES: Record<VatTreatment, string> = { plus_vat: "Plus VAT", vat_included: "VAT Included", no_vat: "No VAT" };

// ---------------------------------------------------------------------
// Per-field validation (shared by request input AND stored values)
// ---------------------------------------------------------------------

export const COACH_PAYMENT_DAY_MIN = 1;
export const COACH_PAYMENT_DAY_MAX = 31;

export type FieldCheck = { ok: true; value: unknown } | { ok: false; error: string };

const CONTROL_RE = /[\u0000-\u0009\u000B-\u001F\u007F]/;
const LINE_CONTROL_RE = /[\u0000-\u001F\u007F]/;

function text(v: unknown, max: number, opts: { multiline?: boolean; pattern?: RegExp; patternError?: string } = {}): FieldCheck {
  if (v === null) return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false, error: "must be text or null" };
  const s = (opts.multiline ? v.replace(/\r\n?/g, "\n") : v).trim();
  if (!s) return { ok: true, value: null };
  if (s.length > max) return { ok: false, error: `must be at most ${max} characters` };
  if ((opts.multiline ? CONTROL_RE : LINE_CONTROL_RE).test(s)) return { ok: false, error: "contains control characters" };
  if (opts.multiline && s.split("\n").length > 8) return { ok: false, error: "must be at most 8 lines" };
  if (opts.pattern && !opts.pattern.test(s)) return { ok: false, error: opts.patternError ?? "has an invalid format" };
  return { ok: true, value: s };
}

function int(v: unknown, min: number, max: number): FieldCheck {
  if (v === null) return { ok: true, value: null };
  if (typeof v !== "number" || !Number.isInteger(v)) return { ok: false, error: "must be a whole number or null" };
  if (v < min || v > max) return { ok: false, error: `must be between ${min} and ${max}` };
  return { ok: true, value: v };
}

export const FIELD_VALIDATORS: Record<SettingsKey, (v: unknown) => FieldCheck> = {
  invoiceLegalName: (v) => text(v, 200),
  invoiceAddress: (v) => text(v, 500, { multiline: true }),
  companyNumber: (v) => text(v, 20, { pattern: /^[A-Za-z0-9][A-Za-z0-9 -]*$/, patternError: "may contain only letters, digits, spaces and hyphens" }),
  vatRegistered: (v) => (v === null || typeof v === "boolean" ? { ok: true, value: v } : { ok: false, error: "must be true, false or null" }),
  vatNumber: (v) => text(v, 20, { pattern: /^[A-Za-z0-9][A-Za-z0-9 ]*$/, patternError: "may contain only letters, digits and spaces" }),
  defaultVatRateBasisPoints: (v) => (v === null || isRateBasisPoints(v) ? { ok: true, value: v } : { ok: false, error: "must be whole basis points 0-10000 (2000 = 20%) or null" }),
  defaultVatTreatment: (v) => (v === null || isVatTreatment(v) ? { ok: true, value: v } : { ok: false, error: `must be one of ${VAT_TREATMENTS.join(", ")} or null` }),
  defaultPaymentTermsDays: (v) => int(v, 0, 365),
  coachPaymentDayOfFollowingMonth: (v) => int(v, COACH_PAYMENT_DAY_MIN, COACH_PAYMENT_DAY_MAX),
};

/** Rules across fields, checked on the MERGED result of an update. Empty object = consistent. */
export function crossFieldErrors(s: FinanceSettings): Partial<Record<SettingsKey, string>> {
  const errors: Partial<Record<SettingsKey, string>> = {};
  if (s.vatRegistered === false) {
    if (s.vatNumber !== null) errors.vatNumber = "must be empty when the organisation is not VAT registered";
    if (s.defaultVatRateBasisPoints !== null) errors.defaultVatRateBasisPoints = "must be empty when the organisation is not VAT registered";
    if (s.defaultVatTreatment !== null && s.defaultVatTreatment !== "no_vat") errors.defaultVatTreatment = "must be no_vat or empty when the organisation is not VAT registered";
  }
  return errors;
}

// ---------------------------------------------------------------------
// Request parsing - POST /settings body (a partial update): { settings: {...}, reason?: string }
// ---------------------------------------------------------------------

export type Invalid = { ok: false; httpStatus: 400; code: string; error: string; fields?: Record<string, string> };
const invalid = (code: string, error: string, fields?: Record<string, string>): Invalid => ({ ok: false, httpStatus: 400, code, error, ...(fields ? { fields } : {}) });

export type SettingsPatch = Partial<FinanceSettings>;
export type ParsedUpdate = { ok: true; patch: SettingsPatch; reason: string | null };

const TOP_LEVEL_KEYS = ["settings", "reason"];

/** `isTenantKey` is injected (F1's finance-access.ts owns the tenant list) to keep this file dependency-light. */
export function parseUpdateBody(raw: string, isTenantKey: (k: string) => boolean): ParsedUpdate | Invalid {
  if (!raw.trim()) return invalid("invalid_body", "Body must be a JSON object: { settings: {...}, reason?: \"...\" }");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return invalid("invalid_body", "Body must be valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("invalid_body", "Body must be a JSON object");
  const top = Object.keys(body as Record<string, unknown>);
  if (top.some(isTenantKey)) return invalid("tenant_param_rejected", "The organisation is taken from your profile and cannot be chosen in the request");
  const unknownTop = top.filter((k) => !TOP_LEVEL_KEYS.includes(k));
  if (unknownTop.length) return invalid("unexpected_field", `Unexpected field(s): ${unknownTop.join(", ")} - only settings and reason may be sent`);

  const settings = (body as Record<string, unknown>).settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return invalid("invalid_body", "settings must be an object of the fields to change");
  const keys = Object.keys(settings as Record<string, unknown>);
  if (keys.some(isTenantKey)) return invalid("tenant_param_rejected", "The organisation is taken from your profile and cannot be chosen in the request");
  const unknown = keys.filter((k) => !(SETTINGS_KEYS as readonly string[]).includes(k));
  if (unknown.length) return invalid("unexpected_field", `Unknown settings field(s): ${unknown.join(", ")}`);
  if (!keys.length) return invalid("invalid_body", "settings must name at least one field to change");

  const patch: Record<string, unknown> = {};
  const fields: Record<string, string> = {};
  for (const k of keys as SettingsKey[]) {
    const r = FIELD_VALIDATORS[k]((settings as Record<string, unknown>)[k]);
    if (r.ok) patch[k] = r.value;
    else fields[k] = r.error;
  }
  if (Object.keys(fields).length) return invalid("invalid_settings", "Some settings are not valid - nothing was saved", fields);

  const rawReason = (body as Record<string, unknown>).reason;
  let reason: string | null = null;
  if (rawReason !== undefined && rawReason !== null) {
    if (typeof rawReason !== "string") return invalid("invalid_settings", "reason must be text", { reason: "must be text" });
    const r = rawReason.trim();
    if (r.length > REASON_MAX) return invalid("invalid_settings", `reason must be at most ${REASON_MAX} characters`, { reason: `must be at most ${REASON_MAX} characters` });
    if (LINE_CONTROL_RE.test(r.replace(/\n/g, " "))) return invalid("invalid_settings", "reason contains control characters", { reason: "contains control characters" });
    reason = r || null;
  }
  return { ok: true, patch: patch as SettingsPatch, reason };
}

export function applyPatch(current: FinanceSettings, patch: SettingsPatch): FinanceSettings {
  const next = { ...current };
  for (const k of SETTINGS_KEYS) if (Object.prototype.hasOwnProperty.call(patch, k)) (next as Record<string, unknown>)[k] = (patch as Record<string, unknown>)[k];
  return next;
}

export function changedKeys(before: FinanceSettings, after: FinanceSettings): SettingsKey[] {
  return SETTINGS_KEYS.filter((k) => before[k] !== after[k]);
}

// ---------------------------------------------------------------------
// Coach payment day -> calendar date
// ---------------------------------------------------------------------

/** Gregorian month length (leap years included) - no month is special-cased. setUTCFullYear avoids Date.UTC's 0-99 => 1900s mapping. */
export function daysInMonth(year: number, month: number): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month, 0);
  return d.getUTCDate();
}

/**
 * The actual payment date in the target (payment) month for a configured
 * Coach payment day. Day 1-31 is valid; when the month is shorter than the
 * configured day, the month's last day is used (31 -> 30 April, 31 or 30 ->
 * 28/29 February). Pure: the configured day is never altered, only the date
 * computed from it. Choosing the target month ("the month after the work")
 * and any bundling are the caller's concern (F12).
 */
export function resolveCoachPaymentDate(configuredDay: unknown, year: unknown, month: unknown): { ok: true; date: string; day: number } | { ok: false; error: string } {
  if (typeof configuredDay !== "number" || !Number.isInteger(configuredDay) || configuredDay < COACH_PAYMENT_DAY_MIN || configuredDay > COACH_PAYMENT_DAY_MAX) {
    return { ok: false, error: `Coach payment day must be a whole number ${COACH_PAYMENT_DAY_MIN}-${COACH_PAYMENT_DAY_MAX}` };
  }
  if (typeof year !== "number" || !Number.isInteger(year) || year < 1 || year > 9999) return { ok: false, error: "year must be a whole number 1-9999" };
  if (typeof month !== "number" || !Number.isInteger(month) || month < 1 || month > 12) return { ok: false, error: "month must be a whole number 1-12" };
  const day = Math.min(configuredDay, daysInMonth(year, month));
  return { ok: true, day, date: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` };
}

// ---------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------

export interface Completeness {
  complete: boolean;
  requiredTotal: number;
  requiredComplete: number;
  missing: SettingsKey[];
}

/** Which settings are required right now. The VAT detail is required only once the organisation says it IS VAT registered. */
export function requiredKeys(s: FinanceSettings): SettingsKey[] {
  const req: SettingsKey[] = ["invoiceLegalName", "invoiceAddress", "vatRegistered"];
  if (s.vatRegistered === true) req.push("vatNumber", "defaultVatRateBasisPoints", "defaultVatTreatment");
  req.push("defaultPaymentTermsDays", "coachPaymentDayOfFollowingMonth");
  return req;
}

export function completeness(s: FinanceSettings): Completeness {
  const req = requiredKeys(s);
  const missing = req.filter((k) => s[k] === null);
  const consistent = Object.keys(crossFieldErrors(s)).length === 0;
  return { complete: missing.length === 0 && consistent, requiredTotal: req.length, requiredComplete: req.length - missing.length, missing };
}

/** The organisation-level default VAT a later slice may fall back to; null while it is not known. Not VAT registered => no_vat. */
export function effectiveDefaultVat(s: FinanceSettings): { treatment: VatTreatment; rateBasisPoints: number } | null {
  if (s.vatRegistered === false) return { treatment: "no_vat", rateBasisPoints: 0 };
  if (s.vatRegistered !== true || s.defaultVatTreatment === null) return null;
  if (s.defaultVatTreatment === "no_vat") return { treatment: "no_vat", rateBasisPoints: 0 };
  if (s.defaultVatRateBasisPoints === null) return null;
  return { treatment: s.defaultVatTreatment, rateBasisPoints: s.defaultVatRateBasisPoints };
}

// ---------------------------------------------------------------------
// Stored record <-> domain
// ---------------------------------------------------------------------

export interface StoredSettingsRow {
  id: string;
  fields: Record<string, any>;
}

export interface SettingsState {
  configured: boolean;
  recordId: string | null;
  revision: number;
  updatedAt: string | null;
  settings: FinanceSettings;
}

export const UNCONFIGURED: SettingsState = Object.freeze({ configured: false, recordId: null, revision: 0, updatedAt: null, settings: EMPTY_SETTINGS });

function selectName(v: unknown): unknown {
  if (v && typeof v === "object" && typeof (v as any).name === "string") return (v as any).name;
  return v;
}

/** Reads one stored row. Any value that would not pass input validation makes the row INVALID (fails closed) - it is never silently treated as blank. */
export function fromStoredRow(row: StoredSettingsRow): { ok: true; state: SettingsState } | { ok: false; problems: string[] } {
  const f = row.fields ?? {};
  const out: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const k of SETTINGS_KEYS) {
    let raw: unknown = selectName(f[FIELD_NAMES[k]]);
    if (raw === undefined || raw === "") raw = null;
    if (k === "vatRegistered" && raw !== null) {
      raw = raw === VAT_REGISTRATION_CHOICES.registered ? true : raw === VAT_REGISTRATION_CHOICES.notRegistered ? false : { unknown: raw };
    }
    if (k === "defaultVatTreatment" && raw !== null) {
      const hit = (Object.keys(TREATMENT_CHOICES) as VatTreatment[]).find((t) => TREATMENT_CHOICES[t] === raw);
      raw = hit ?? { unknown: raw };
    }
    const r = FIELD_VALIDATORS[k](raw);
    if (r.ok) out[k] = r.value;
    else problems.push(FIELD_NAMES[k]);
  }
  const revRaw = f[STORED.revision];
  const revision = revRaw == null || revRaw === "" ? 0 : revRaw;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) problems.push(STORED.revision);
  const changedAt = f[STORED.changedAt];
  if (changedAt != null && typeof changedAt !== "string") problems.push(STORED.changedAt);
  if (problems.length) return { ok: false, problems };
  const settings = out as unknown as FinanceSettings;
  const cross = crossFieldErrors(settings);
  if (Object.keys(cross).length) return { ok: false, problems: Object.keys(cross).map((k) => FIELD_NAMES[k as SettingsKey]) };
  return { ok: true, state: { configured: true, recordId: row.id, revision: revision as number, updatedAt: (changedAt as string) ?? null, settings } };
}

/** Airtable field values for exactly `keys` (null clears the cell). */
export function toStoredFields(s: FinanceSettings, keys: readonly SettingsKey[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = s[k];
    if (k === "vatRegistered") out[FIELD_NAMES[k]] = v === null ? null : v ? VAT_REGISTRATION_CHOICES.registered : VAT_REGISTRATION_CHOICES.notRegistered;
    else if (k === "defaultVatTreatment") out[FIELD_NAMES[k]] = v === null ? null : TREATMENT_CHOICES[v as VatTreatment];
    else out[FIELD_NAMES[k]] = v;
  }
  return out;
}

export function settingsRowId(organisationId: string): string {
  return `FINSET-${organisationId}`;
}

// ---------------------------------------------------------------------
// Public response - never Airtable ids, user ids or audit internals
// ---------------------------------------------------------------------

export interface SettingsBody {
  contract: typeof SETTINGS_CONTRACT;
  organisation: { organisationId: string; name: string | null };
  access: "view" | "manage";
  configured: boolean;
  revision: number;
  updatedAt: string | null;
  settings: FinanceSettings;
  completeness: Completeness;
}

export function buildSettingsBody(org: { organisationId: string; name: string | null }, access: "view" | "manage", state: SettingsState): SettingsBody {
  return {
    contract: SETTINGS_CONTRACT,
    organisation: { organisationId: org.organisationId, name: org.name },
    access,
    configured: state.configured,
    revision: state.revision,
    updatedAt: state.updatedAt,
    settings: { ...state.settings },
    completeness: completeness(state.settings),
  };
}

// ---------------------------------------------------------------------
// Audit event (Finance audit trail contract)
// ---------------------------------------------------------------------

export interface FinanceAuditEvent {
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

export function buildSettingsAuditEvent(input: {
  organisationId: string;
  actorUserId: string;
  recordId: string;
  before: SettingsState;
  after: FinanceSettings;
  revision: number;
  changed: readonly SettingsKey[];
  reason: string | null;
}): FinanceAuditEvent {
  return {
    organisation_id: input.organisationId,
    actor_user_id: input.actorUserId,
    event_type: input.before.configured ? SETTINGS_EVENT_UPDATED : SETTINGS_EVENT_CREATED,
    entity_type: SETTINGS_ENTITY_TYPE,
    record_id: input.recordId,
    before: input.before.configured ? { revision: input.before.revision, settings: { ...input.before.settings } } : null,
    after: { revision: input.revision, settings: { ...input.after } },
    reason: input.reason,
    context: { source: "finance-api", route: "POST /settings", contract: SETTINGS_CONTRACT, changedFields: [...input.changed] },
  };
}
