/**
 * Finance Settings orchestration (Finance Foundation F2; see TEST-ENV.md
 * "Finance Foundation - F2"). Every call authorises through F1's
 * authorizeFinance() first - no new auth path.
 *
 * GET:    Finance read (View or Manage) -> current Settings + completeness.
 *         Missing configuration is a normal 200 (configured:false); a store
 *         failure is 503; stored data that does not validate is 409 - the
 *         three are never confused. Reads write nothing and audit nothing.
 *
 * UPDATE: Finance manage only. Order (first failure wins, nothing is
 * written before step 5):
 *   1. authorise (manage)
 *   2. per-organisation write lock            -> 409 finance_settings_busy
 *   3. load current row (0 = unconfigured, >1 or invalid = 409)
 *   4. merge + cross-field validation          -> 400 invalid_settings
 *      no effective change                     -> 200 changed:false, no write, no event
 *   5. one Airtable write (create or patch changed fields, revision + 1)
 *   6. exactly one audit event (before / after / actor / reason)
 *      audit write fails -> the step-5 write is undone (compensating delete
 *      of a row this request created, or patch back to the before values)
 *      and the caller gets 503 - no unaudited change is left in place.
 *   7. release the lock (always)
 */
import type { FinanceCaller } from "./finance-access.ts";
import { type Deps, authorizeFinance } from "./orchestrator.ts";
import {
  type FinanceSettings,
  type ParsedUpdate,
  type SettingsBody,
  type SettingsState,
  type StoredSettingsRow,
  SETTINGS_KEYS,
  STORED,
  UNCONFIGURED,
  applyPatch,
  buildSettingsAuditEvent,
  buildSettingsBody,
  changedKeys,
  crossFieldErrors,
  fromStoredRow,
  settingsRowId,
  toStoredFields,
} from "./finance-settings.ts";
import {
  acquireSettingsLock,
  createSettingsRow,
  deleteCreatedSettingsRow,
  insertAuditEvent,
  loadSettingsRows,
  patchSettingsRow,
  releaseSettingsLock,
} from "./finance-settings-repository.ts";

export interface SettingsDeps extends Deps {
  /** Injected for tests; defaults to the real clock. */
  clock?: () => Date;
}

export type SettingsFail = { status: "error"; httpStatus: 400 | 403 | 409 | 500 | 503; code: string; error: string; fields?: Record<string, string> };
const fail = (httpStatus: SettingsFail["httpStatus"], code: string, error: string, fields?: Record<string, string>): SettingsFail => ({ status: "error", httpStatus, code, error, ...(fields ? { fields } : {}) });

type Loaded = { ok: true; state: SettingsState; row: StoredSettingsRow | null } | SettingsFail;

async function loadState(deps: SettingsDeps, organisationRecordId: string): Promise<Loaded> {
  let rows: StoredSettingsRow[];
  try {
    rows = await loadSettingsRows(deps.airtable, organisationRecordId);
  } catch (e) {
    console.error(e);
    return fail(503, "finance_settings_unavailable", "Finance Settings could not be loaded just now - try again");
  }
  if (rows.length === 0) return { ok: true, state: UNCONFIGURED, row: null };
  if (rows.length > 1) return fail(409, "finance_settings_ambiguous", `${rows.length} Finance Settings records exist for your organisation - one must be removed before Settings can be used`);
  const row = rows[0];
  if ((row.fields[STORED.organisation] as unknown[]).length !== 1) return fail(409, "finance_settings_invalid", "The Finance Settings record is linked to more than one organisation");
  const parsed = fromStoredRow(row);
  if (!parsed.ok) return fail(409, "finance_settings_invalid", `Stored Finance Settings are not valid (${parsed.problems.join(", ")}) - they must be corrected before use`);
  return { ok: true, state: parsed.state, row };
}

export async function getFinanceSettings(deps: SettingsDeps, caller: FinanceCaller): Promise<{ status: "ok"; body: SettingsBody } | SettingsFail> {
  const auth = await authorizeFinance(deps, caller, "read");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const loaded = await loadState(deps, auth.organisation.recordId);
  if (!loaded.ok) return loaded;
  return { status: "ok", body: buildSettingsBody(auth.organisation, auth.access, loaded.state) };
}

export async function updateFinanceSettings(
  deps: SettingsDeps,
  caller: FinanceCaller,
  update: ParsedUpdate
): Promise<{ status: "ok"; body: SettingsBody & { changed: boolean } } | SettingsFail> {
  const auth = await authorizeFinance(deps, caller, "manage");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;

  let token: string | null;
  try {
    token = await acquireSettingsLock(deps.grants, org.organisationId);
  } catch (e) {
    console.error(e);
    return fail(503, "finance_settings_unavailable", "Finance Settings could not be saved just now - try again");
  }
  if (!token) return fail(409, "finance_settings_busy", "Finance Settings are being changed by someone else right now - try again in a moment");

  try {
    const loaded = await loadState(deps, org.recordId);
    if (!loaded.ok) return loaded;
    const before = loaded.state;

    const merged: FinanceSettings = applyPatch(before.settings, update.patch);
    const cross = crossFieldErrors(merged);
    if (Object.keys(cross).length) return fail(400, "invalid_settings", "Some settings are not valid together - nothing was saved", cross as Record<string, string>);

    const changed = changedKeys(before.settings, merged);
    if (!changed.length) return { status: "ok", body: { ...buildSettingsBody(org, "manage", before), changed: false } };

    const now = (deps.clock ?? (() => new Date()))().toISOString();
    const revision = before.revision + 1;
    const meta = { [STORED.revision]: revision, [STORED.changedBy]: caller.userId, [STORED.changedAt]: now };

    let written: StoredSettingsRow;
    try {
      written = before.configured
        ? await patchSettingsRow(deps.airtable, before.recordId as string, { ...toStoredFields(merged, changed), ...meta })
        : await createSettingsRow(deps.airtable, {
            [STORED.id]: settingsRowId(org.organisationId),
            [STORED.organisation]: [org.recordId],
            ...toStoredFields(merged, SETTINGS_KEYS),
            ...meta,
          });
    } catch (e) {
      console.error(e);
      return fail(503, "finance_settings_unavailable", "Finance Settings could not be saved just now - nothing was changed");
    }

    const event = buildSettingsAuditEvent({
      organisationId: org.organisationId,
      actorUserId: caller.userId,
      recordId: written.id,
      before,
      after: merged,
      revision,
      changed,
      reason: update.reason,
    });
    try {
      await insertAuditEvent(deps.grants, event);
    } catch (auditError) {
      console.error(auditError);
      try {
        if (before.configured) {
          const prev = loaded.row?.fields ?? {};
          await patchSettingsRow(deps.airtable, written.id, {
            ...toStoredFields(before.settings, changed),
            [STORED.revision]: before.revision,
            [STORED.changedBy]: prev[STORED.changedBy] ?? null,
            [STORED.changedAt]: prev[STORED.changedAt] ?? null,
          });
        } else {
          await deleteCreatedSettingsRow(deps.airtable, written.id);
        }
      } catch (undoError) {
        console.error("FINANCE SETTINGS CHANGED WITHOUT AN AUDIT EVENT AND COULD NOT BE UNDONE", { organisation: org.organisationId, record: written.id, revision }, undoError);
        return fail(500, "finance_settings_unaudited", "The change was saved but could not be audited or undone - contact support before changing Finance Settings again");
      }
      return fail(503, "finance_audit_unavailable", "Finance Settings could not be saved just now (the change could not be recorded) - nothing was changed");
    }

    const after: SettingsState = { configured: true, recordId: written.id, revision, updatedAt: now, settings: merged };
    return { status: "ok", body: { ...buildSettingsBody(org, "manage", after), changed: true } };
  } finally {
    try {
      await releaseSettingsLock(deps.grants, org.organisationId, token);
    } catch (e) {
      console.error("Finance Settings lock release failed (expires on its own)", e);
    }
  }
}
