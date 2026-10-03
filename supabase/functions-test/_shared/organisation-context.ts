/**
 * Shared organisation context + module state (Settings / Config S1-a).
 *
 * ONE source for:
 *   - resolveOrganisationContext(caller, orgRows): which organisation an
 *     authenticated caller belongs to;
 *   - getModuleState(featureRows, key): whether a module is available;
 *   - todayIn(ctx): the organisation's calendar date.
 *
 * Organisation rules (never "first Active row"):
 *   1. the caller's profile must be active;
 *   2. the organisation comes ONLY from profiles.organisation_id (never from
 *      the request);
 *   3. exactly one Active "Organisation & Branding" row whose Organisation
 *      ID equals it (exact string, no case-folding);
 *   4. two or more such rows -> organisation_ambiguous; none while another
 *      organisation is active here -> organisation_mismatch; no active
 *      organisation at all -> organisation_not_found;
 *   5. Organisation ID text is the cross-domain identity. The Airtable
 *      record id is internal and never leaves the backend.
 *
 * Same match rule as the existing copies in finance/finance-access.ts,
 * needs-attention/needs-attention.ts and session-occurrences/
 * occurrence-confirmation.ts (drift-tested in tests/support/
 * settings-system.test.ts); those callers are not switched over in S1-a.
 *
 * Module rules:
 *   - core modules are always on and are not switches; Feature Controls
 *     rows cannot turn them off;
 *   - optional modules need exactly-enabled rows: missing or conflicting
 *     rows = off (fail closed);
 *   - not-built modules are always off, whatever a row says;
 *   - legacy keys (legacy_assigned_coaches) are NOT answered here, so the
 *     old "missing row = on" rule can never leak into this contract;
 *   - a module never grants or removes a permission. Role and grant checks
 *     stay with each domain.
 *
 * Feature Controls has no organisation column (one base = one
 * organisation), so callers load the rows for the resolved organisation's
 * base and pass them in.
 *
 * Portable: no Deno or network APIs; the Edge Functions and the Node tests
 * run this same file.
 */

export type ConfigRow = { id: string; fields: Record<string, any> };

export const ORGANISATION_TABLE = "Organisation & Branding";
export const FEATURE_TABLE = "Feature Controls";
export const DEFAULT_TIMEZONE = "Europe/London";
export const CURRENCY = "GBP";

export interface OrganisationCaller {
  active: boolean;
  organisationId: string | null | undefined;
}

export interface OrganisationContext {
  organisationId: string;
  /** Airtable record id - internal only, never returned to clients. */
  organisationRecordId: string;
  displayName: string;
  timezone: string;
  /** "organisation" when read from the record, "default" when the record left it blank. */
  timezoneSource: "organisation" | "default";
  currency: string;
  active: true;
}

export type OrganisationFailureCode =
  | "inactive_profile"
  | "organisation_not_found"
  | "organisation_ambiguous"
  | "organisation_mismatch"
  | "organisation_timezone_invalid";

export type OrganisationResult =
  | { ok: true; context: OrganisationContext }
  | { ok: false; code: OrganisationFailureCode; status: number; error: string };

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const FAILURES: Record<OrganisationFailureCode, { status: number; error: string }> = {
  inactive_profile: { status: 403, error: "This account is not active." },
  organisation_not_found: { status: 409, error: "Your organisation could not be found. Please contact support." },
  organisation_ambiguous: { status: 409, error: "Your organisation is set up more than once. Please contact support." },
  organisation_mismatch: { status: 403, error: "Your account does not belong to this organisation." },
  organisation_timezone_invalid: { status: 409, error: "Your organisation's timezone is not valid. Please contact support." },
};

function fail(code: OrganisationFailureCode): OrganisationResult {
  return { ok: false, code, ...FAILURES[code] };
}

export function resolveOrganisationContext(caller: OrganisationCaller, orgRows: ConfigRow[]): OrganisationResult {
  if (!caller || caller.active !== true) return fail("inactive_profile");
  const wanted = text(caller.organisationId);
  const activeRows = orgRows.filter((r) => r.fields?.["Active"] === true);
  if (!wanted) return fail("organisation_not_found");
  const matches = activeRows.filter((r) => text(r.fields?.["Organisation ID"]) === wanted);
  if (matches.length > 1) return fail("organisation_ambiguous");
  if (matches.length === 0) return fail(activeRows.length > 0 ? "organisation_mismatch" : "organisation_not_found");
  const row = matches[0];
  const recorded = text(row.fields["Timezone"]);
  if (recorded && !isValidTimeZone(recorded)) return fail("organisation_timezone_invalid");
  return {
    ok: true,
    context: {
      organisationId: wanted,
      organisationRecordId: row.id,
      displayName: text(row.fields["Organisation Name"]),
      timezone: recorded || DEFAULT_TIMEZONE,
      timezoneSource: recorded ? "organisation" : "default",
      currency: CURRENCY,
      active: true,
    },
  };
}

/** The calendar date "now" (YYYY-MM-DD) in the organisation's timezone. */
export function todayIn(ctx: { timezone: string }, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: ctx.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// ---------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------

export type ModuleKind = "core" | "optional" | "unavailable";
export interface ModuleDefinition {
  key: string;
  label: string;
  kind: ModuleKind;
  /** Shown in the Settings & System overview. */
  userFacing: boolean;
}

export const MODULES: readonly ModuleDefinition[] = [
  { key: "module_schedule", label: "Schedule & Sessions", kind: "core", userFacing: true },
  { key: "module_coaches", label: "Coaches", kind: "core", userFacing: true },
  { key: "module_players_parents", label: "Players & Parents", kind: "core", userFacing: true },
  { key: "module_system", label: "System & Data", kind: "core", userFacing: true },
  { key: "module_finance", label: "Finance", kind: "optional", userFacing: true },
  { key: "module_development", label: "Development", kind: "optional", userFacing: false },
  { key: "module_communications", label: "Communications", kind: "unavailable", userFacing: false },
  { key: "module_safeguarding", label: "Safeguarding", kind: "unavailable", userFacing: false },
];

/** Keys with their own documented legacy behaviour; never answered by this contract. */
export const LEGACY_FEATURE_KEYS: readonly string[] = ["legacy_assigned_coaches"];

export type ModuleReason = "enabled" | "disabled" | "missing" | "conflicting" | "core" | "unavailable" | "legacy" | "unknown";
export interface ModuleState {
  key: string;
  enabled: boolean;
  reason: ModuleReason;
}

export function moduleDefinition(key: string): ModuleDefinition | null {
  return MODULES.find((m) => m.key === key) ?? null;
}

export function getModuleState(featureRows: ConfigRow[], key: string): ModuleState {
  if (LEGACY_FEATURE_KEYS.includes(key)) return { key, enabled: false, reason: "legacy" };
  const def = moduleDefinition(key);
  if (!def) return { key, enabled: false, reason: "unknown" };
  if (def.kind === "core") return { key, enabled: true, reason: "core" };
  if (def.kind === "unavailable") return { key, enabled: false, reason: "unavailable" };
  const rows = featureRows.filter((r) => text(r.fields?.["Feature Key"]) === key);
  if (rows.length === 0) return { key, enabled: false, reason: "missing" };
  const on = rows.filter((r) => r.fields["Enabled"] === true).length;
  if (on === rows.length) return { key, enabled: true, reason: "enabled" };
  if (on === 0) return { key, enabled: false, reason: "disabled" };
  return { key, enabled: false, reason: "conflicting" };
}
