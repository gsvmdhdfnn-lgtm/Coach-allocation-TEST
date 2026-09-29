/**
 * Finance access orchestration (Finance Foundation F1; see TEST-ENV.md
 * "Finance Foundation - F1"). Composes the pure policy (finance-access.ts)
 * with the read-only repository (repository.ts). Every later Finance route
 * authorises through authorizeFinance() before touching any data.
 *
 * Decision order (first failure wins, everything fails closed):
 *   1. active Management profile                    -> else 403 management_required
 *   2. one valid, unrevoked grant for the caller's
 *      OWN profile organisation                     -> else 403 finance_access_denied
 *   3. that organisation resolves to exactly one
 *      Active Organisation & Branding row            -> else 409 organisation_not_found / _ambiguous
 *   4. Feature Controls module_finance enabled       -> else 403 finance_module_disabled
 *   5. the route's requirement (read / manage)       -> else 403 finance_manage_required
 * A grant-store or Airtable read failure is 503 - never "assume access".
 */
import {
  type FinanceCaller,
  type FinanceLevel,
  type FinanceRequirement,
  type OrganisationContext,
  FINANCE_MODULE_KEY,
  isFinanceEligible,
  moduleState,
  resolveFinanceAccess,
  resolveOrganisation,
  satisfies,
} from "./finance-access.ts";
import { type AirtableConfig, type GrantStoreConfig, loadFinanceConfig, loadFinanceGrants } from "./repository.ts";

export interface Deps {
  airtable: AirtableConfig;
  grants: GrantStoreConfig;
}

export type Authorized = { status: "ok"; organisation: OrganisationContext; access: FinanceLevel };
export type Denied = { status: "denied"; httpStatus: 403 | 409 | 503; code: string; error: string };

const deny = (httpStatus: Denied["httpStatus"], code: string, error: string): Denied => ({ status: "denied", httpStatus, code, error });

export async function authorizeFinance(deps: Deps, caller: FinanceCaller, required: FinanceRequirement): Promise<Authorized | Denied> {
  if (!isFinanceEligible(caller).ok) return deny(403, "management_required", "Management access required");

  let grants;
  try {
    grants = await loadFinanceGrants(deps.grants, caller.userId);
  } catch (e) {
    console.error(e);
    return deny(503, "finance_access_unavailable", "Finance access could not be checked just now - try again");
  }
  const access = resolveFinanceAccess(caller, grants);
  if (access.access === "none") return deny(403, "finance_access_denied", "You do not have Finance access");

  let cfg;
  try {
    cfg = await loadFinanceConfig(deps.airtable);
  } catch (e) {
    console.error(e);
    return deny(503, "finance_config_unavailable", "Finance could not be checked just now - try again");
  }
  const org = resolveOrganisation(caller.organisationId, cfg.organisations);
  if (!org.ok) return deny(409, org.code, org.error);

  if (!moduleState(cfg.features, FINANCE_MODULE_KEY).active) return deny(403, "finance_module_disabled", "Finance is not switched on for your organisation");

  if (!satisfies(access.access, required)) return deny(403, "finance_manage_required", "This action needs Finance Manage access");

  return { status: "ok", organisation: org.organisation, access: access.access };
}
