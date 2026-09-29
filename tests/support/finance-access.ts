/**
 * Test-suite copy of the canonical finance/finance-access.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * finance-access.test.ts). Only import paths adjusted:
 * ./repository.ts -> ./finance-repository.ts.
 */
/**
 * Finance access policy - PURE (Finance Foundation F1; see TEST-ENV.md
 * "Finance Foundation - F1"). No HTTP, Airtable, Supabase or Deno code
 * lives here: the access level, organisation and module decisions are plain
 * functions over already-loaded data, so a later repository swap (Airtable
 * -> Supabase) only replaces repository.ts wiring, never this file.
 *
 * Locked model:
 *   - Finance access is separate from Management access. Three states:
 *     none / view / manage. Management never implies Finance access.
 *   - Only an ACTIVE Management profile may hold a Finance grant; a grant
 *     held by any other profile is ignored (fails closed).
 *   - A grant counts only when it is unrevoked AND belongs to the caller's
 *     own profile organisation. Unknown levels, several active grants, or a
 *     grant for another organisation all resolve to "none" - never guessed.
 *   - view => Finance read; manage => Finance read + write.
 *   - The organisation comes only from the caller's profile, matched to
 *     exactly one Active "Organisation & Branding" row; the module gate is
 *     the existing Feature Controls key `module_finance`.
 */

export interface AirtableRecord {
  id: string;
  fields: Record<string, any>;
  createdTime?: string;
}

export const FINANCE_MODULE_KEY = "module_finance";
export const FINANCE_CONTRACT = "finance-access-v1";

export const FINANCE_ACCESS_LEVELS = ["view", "manage"] as const;
export type FinanceLevel = (typeof FINANCE_ACCESS_LEVELS)[number];
export type FinanceAccess = "none" | FinanceLevel;
/** What a route requires: `read` is satisfied by view or manage, `manage` only by manage. */
export type FinanceRequirement = "read" | "manage";

export interface FinanceCaller {
  userId: string;
  role: string | null;
  active: boolean;
  organisationId: string | null;
}

/** A row of public.finance_access_grants, as read by the repository (only the columns the policy needs). */
export interface FinanceGrantRow {
  organisation_id: unknown;
  access_level: unknown;
  revoked_at: unknown;
}

export type AccessReason =
  | "granted"
  | "not_management"
  | "inactive_profile"
  | "no_profile_organisation"
  | "no_grant"
  | "grant_invalid"
  | "grant_ambiguous";

export interface AccessResolution {
  access: FinanceAccess;
  reason: AccessReason;
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (v && typeof v === "object" && typeof (v as any).name === "string" && (v as any).name.trim()) return (v as any).name.trim();
  return null;
}

/** Only an active Management profile may use Finance at all. */
export function isFinanceEligible(caller: FinanceCaller): { ok: true } | { ok: false; reason: "not_management" | "inactive_profile" } {
  if (caller.role !== "management") return { ok: false, reason: "not_management" };
  if (caller.active !== true) return { ok: false, reason: "inactive_profile" };
  return { ok: true };
}

/**
 * The caller's Finance access in their OWN profile organisation.
 * `grants` must be the caller's rows only (the repository filters by
 * user id); this function still ignores revoked rows and other
 * organisations' rows, and fails closed on anything unexpected.
 */
export function resolveFinanceAccess(caller: FinanceCaller, grants: readonly FinanceGrantRow[]): AccessResolution {
  const eligible = isFinanceEligible(caller);
  if (!eligible.ok) return { access: "none", reason: eligible.reason };
  const org = typeof caller.organisationId === "string" ? caller.organisationId.trim() : "";
  if (!org) return { access: "none", reason: "no_profile_organisation" };
  const current = grants.filter((g) => g && g.revoked_at == null && typeof g.organisation_id === "string" && g.organisation_id.trim() === org);
  if (current.length === 0) return { access: "none", reason: "no_grant" };
  if (current.length > 1) return { access: "none", reason: "grant_ambiguous" };
  const level = current[0].access_level;
  if (typeof level !== "string" || !(FINANCE_ACCESS_LEVELS as readonly string[]).includes(level)) return { access: "none", reason: "grant_invalid" };
  return { access: level as FinanceLevel, reason: "granted" };
}

export function satisfies(access: FinanceAccess, required: FinanceRequirement): boolean {
  if (access === "manage") return true;
  if (access === "view") return required === "read";
  return false;
}

export function capabilitiesFor(access: FinanceAccess): { read: boolean; manage: boolean } {
  return { read: satisfies(access, "read"), manage: satisfies(access, "manage") };
}

// ---------------------------------------------------------------------
// Tenant selectors - refused outright, never silently ignored
// ---------------------------------------------------------------------

/** Compared case-insensitively. Anything that could select an organisation, tenant or Airtable base. */
export const TENANT_KEYS = [
  "organisation", "organisationId", "organisation_id", "organization", "organizationId", "organization_id",
  "org", "orgId", "org_id", "tenant", "tenantId", "tenant_id",
  "base", "baseId", "base_id", "airtableBase", "airtableBaseId", "airtable_base_id",
];
const TENANT_KEYS_LOWER = new Set(TENANT_KEYS.map((k) => k.toLowerCase()));

export function isTenantKey(key: string): boolean {
  return TENANT_KEYS_LOWER.has(key.toLowerCase());
}

export type InputCheck = { ok: true } | { ok: false; code: "tenant_param_rejected" | "unexpected_parameter" | "unexpected_field" | "invalid_body"; error: string };

const TENANT_ERROR = "The organisation is taken from your profile and cannot be chosen in the request";

/** F1 routes accept no query parameters: tenant selectors are 400 tenant_param_rejected, anything else 400 unexpected_parameter. */
export function checkQueryKeys(keys: readonly string[]): InputCheck {
  if (keys.some(isTenantKey)) return { ok: false, code: "tenant_param_rejected", error: TENANT_ERROR };
  if (keys.length) return { ok: false, code: "unexpected_parameter", error: `This route accepts no query parameters (got ${keys.join(", ")})` };
  return { ok: true };
}

/** F1 write routes accept no body fields: an empty body or {} only. `raw` is the unparsed request text. */
export function checkEmptyBody(raw: string): InputCheck {
  if (!raw.trim()) return { ok: true };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, code: "invalid_body", error: "Body must be empty or a JSON object" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, code: "invalid_body", error: "Body must be empty or a JSON object" };
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.some(isTenantKey)) return { ok: false, code: "tenant_param_rejected", error: TENANT_ERROR };
  if (keys.length) return { ok: false, code: "unexpected_field", error: `This route accepts no body fields (got ${keys.join(", ")})` };
  return { ok: true };
}

// ---------------------------------------------------------------------
// Organisation + module (copied verbatim from needs-attention/needs-attention.ts;
// kept byte-identical by the drift checks in tests/support/finance-access.test.ts)
// ---------------------------------------------------------------------

export interface OrganisationContext {
  recordId: string;
  organisationId: string;
  name: string | null;
  timezone: string;
}

export type OrganisationResolution =
  | { ok: true; organisation: OrganisationContext }
  | { ok: false; code: "organisation_not_found" | "organisation_ambiguous"; error: string };

/**
 * `profileOrganisationId` comes ONLY from the authenticated caller's
 * Supabase profile - never from the request. Exact string match on the
 * Airtable "Organisation ID" of an Active Organisation & Branding row; no
 * aliases, no case-folding, no fallback to "the only row".
 */
export function resolveOrganisation(profileOrganisationId: string | null | undefined, orgRecords: AirtableRecord[]): OrganisationResolution {
  const wanted = typeof profileOrganisationId === "string" ? profileOrganisationId.trim() : "";
  if (!wanted) return { ok: false, code: "organisation_not_found", error: "Your profile has no organisation" };
  const matches = orgRecords.filter((r) => r.fields?.["Active"] === true && str(r.fields?.["Organisation ID"]) === wanted);
  if (matches.length === 0) return { ok: false, code: "organisation_not_found", error: `No active organisation matches ${wanted}` };
  if (matches.length > 1) return { ok: false, code: "organisation_ambiguous", error: `${matches.length} active organisations match ${wanted}` };
  const r = matches[0];
  return {
    ok: true,
    organisation: { recordId: r.id, organisationId: wanted, name: str(r.fields["Organisation Name"]), timezone: str(r.fields["Timezone"]) ?? "Europe/London" },
  };
}

export interface ModuleState {
  key: string | null;
  active: boolean;
  reason: "enabled" | "disabled" | "missing" | "conflicting" | "no_module";
}

export function moduleState(featureRecords: AirtableRecord[], key: string | null): ModuleState {
  if (!key) return { key, active: false, reason: "no_module" };
  const rows = featureRecords.filter((r) => str(r.fields?.["Feature Key"]) === key);
  if (rows.length === 0) return { key, active: false, reason: "missing" };
  const on = rows.filter((r) => r.fields["Enabled"] === true).length;
  if (on === rows.length) return { key, active: true, reason: "enabled" };
  if (on === 0) return { key, active: false, reason: "disabled" };
  return { key, active: false, reason: "conflicting" };
}

// ---------------------------------------------------------------------
// Public response - the ONLY Finance context a caller is ever shown
// ---------------------------------------------------------------------

export interface FinanceAccessBody {
  contract: typeof FINANCE_CONTRACT;
  organisation: { organisationId: string; name: string | null };
  module: { key: typeof FINANCE_MODULE_KEY; enabled: true };
  access: FinanceLevel;
  capabilities: { read: boolean; manage: boolean };
}

export function buildAccessBody(organisation: OrganisationContext, access: FinanceLevel): FinanceAccessBody {
  return {
    contract: FINANCE_CONTRACT,
    organisation: { organisationId: organisation.organisationId, name: organisation.name },
    module: { key: FINANCE_MODULE_KEY, enabled: true },
    access,
    capabilities: capabilitiesFor(access),
  };
}
