/**
 * Finance Foundation F2 - Finance Settings + Finance audit trail.
 * Run: node --experimental-strip-types tests/support/finance-settings.test.ts
 *
 *   S   pure Settings domain (field validation, cross-field rules, completeness, stored mapping)
 *   D   Coach payment day -> calendar date (1-31, shorter months fall back to their last day)
 *   P   POST /settings body parsing (unknown / tenant / dangerous / malformed input)
 *   G   GET /settings through the orchestrator (access matrix, missing vs invalid vs unavailable, isolation, reads write nothing)
 *   U   UPDATE through the orchestrator (one write + exactly one audit event, no-op, invalid, lock, failure + compensation)
 *   C   public response contract (no internals leak)
 *   Z   code / drift checks against the canonical supabase/functions-test/finance files
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FinanceGrantRow, FINANCE_MODULE_KEY, isTenantKey } from "./finance-access.ts";
import {
  type FinanceSettings,
  EMPTY_SETTINGS,
  FIELD_NAMES,
  SETTINGS_KEYS,
  applyPatch,
  buildSettingsAuditEvent,
  changedKeys,
  completeness,
  crossFieldErrors,
  daysInMonth,
  effectiveDefaultVat,
  fromStoredRow,
  parseUpdateBody,
  resolveCoachPaymentDate,
  toStoredFields,
} from "./finance-settings.ts";
import { SETTINGS_RETRY_DELAYS_MS } from "./finance-settings-repository.ts";
import { RETRY_DELAYS_MS } from "./finance-repository.ts";
import { type SettingsDeps, getFinanceSettings, updateFinanceSettings } from "./finance-settings-orchestrator.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CANON = join(HERE, "..", "..", "supabase", "functions-test", "finance");

const R: [string, string, string?][] = [];
let failed = 0;
function ck(name: string, cond: unknown, extra?: string) {
  const ok = !!cond;
  if (!ok) failed++;
  R.push([ok ? "PASS" : "FAIL", name, extra]);
}

const ORG = "ORG-TEST-001";
const ORG_REC = "recYXqi1DTZ8ZECPQ";
const OTHER_REC = "recOtherOrgRow001";
const MGR = "285f819e-e0d4-4257-8121-5f16781e97ba";
const COACH = "1bc04193-ee30-4fa3-a5fd-bf7cc0dac504";
const NEW_REC = "recNewSettings001";
const g = (level: unknown, org: unknown = ORG, revoked: unknown = null): FinanceGrantRow => ({ organisation_id: org, access_level: level, revoked_at: revoked });
const mgr = { userId: MGR, role: "management", active: true, organisationId: ORG };

const FULL: FinanceSettings = {
  invoiceLegalName: "Test Coaching Ltd",
  invoiceAddress: "1 Test Street\nTestville\nTE1 1ST",
  companyNumber: "01234567",
  vatRegistered: true,
  vatNumber: "GB123456789",
  defaultVatRateBasisPoints: 2000,
  defaultVatTreatment: "vat_included",
  defaultPaymentTermsDays: 14,
  coachPaymentDayOfFollowingMonth: 7,
  invoiceNumberAuthority: "hub",
  invoiceNumberPrefix: "INV-",
  invoiceNumberNext: 1001,
  invoiceNumberDigits: 4,
  estimateReminderDays: null,
  cashSafetyThresholdMinor: 500000,
  overviewCashSummaryVisible: false,
};
const storedRow = (s: FinanceSettings, over: Record<string, unknown> = {}, id = "recSettingsRow001") => ({
  id,
  fields: Object.fromEntries(
    Object.entries({ "Finance Settings ID": `FINSET-${ORG}`, Organisation: [ORG_REC], ...toStoredFields(s, SETTINGS_KEYS), Revision: 3, "Last Changed By User ID": MGR, "Last Changed At": "2026-09-29T09:00:00.000Z", ...over }).filter(([, v]) => v !== null)
  ),
});

// ---------------------------------------------------------------------------
// fetch mock: grant store, Airtable config + Finance Settings, audit table, lock RPCs
// ---------------------------------------------------------------------------
interface World {
  grants: Record<string, FinanceGrantRow[]>;
  features: { id: string; fields: Record<string, unknown> }[];
  settings: { id: string; fields: Record<string, any> }[];
  audit: Record<string, any>[];
  lockHeld: string | null;
  lockMode: "ok" | "busy" | "error";
  releases: number;
  settingsReadStatus?: number;
  settingsWriteStatus?: number;
  auditStatus?: number;
  undoStatus?: number;
}
let world: World;
let calls: { url: string; method: string; body?: any }[] = [];
const ORG_ROW = { id: ORG_REC, fields: { "Organisation ID": ORG, "Organisation Name": "Test Org", Timezone: "Europe/London", Active: true } };
const FIN_ON = { id: "recI5wFXcjUfY6BXy", fields: { "Feature Key": FINANCE_MODULE_KEY, Enabled: true } };
const FIN_OFF = { id: "recI5wFXcjUfY6BXy", fields: { "Feature Key": FINANCE_MODULE_KEY } };

function reset(over: Partial<World> = {}) {
  world = { grants: { [MGR]: [g("manage")] }, features: [FIN_ON], settings: [], audit: [], lockHeld: null, lockMode: "ok", releases: 0, ...over };
  calls = [];
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const SETTINGS_PATH = `/${encodeURIComponent("Finance Settings")}`;

globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(input);
  const method = (init.method || "GET").toUpperCase();
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ url, method, body });
  if (url.includes("/rest/v1/finance_access_grants") && method === "GET") {
    const m = /^eq\.(.+)$/.exec(new URL(url).searchParams.get("user_id") || "");
    return json(m ? world.grants[m[1]] ?? [] : []);
  }
  if (url.includes("/rest/v1/rpc/acquire_finance_settings_lock")) {
    if (world.lockMode === "error") return json({ message: "boom" }, 500);
    if (world.lockMode === "busy" || world.lockHeld) return json(null);
    world.lockHeld = "11111111-1111-4111-8111-111111111111";
    return json(world.lockHeld);
  }
  if (url.includes("/rest/v1/rpc/release_finance_settings_lock")) {
    world.releases++;
    const ok = world.lockHeld !== null && body?.p_lock_token === world.lockHeld && body?.p_organisation_id === ORG;
    if (ok) world.lockHeld = null;
    return json(ok);
  }
  if (url.includes("/rest/v1/finance_audit_events") && method === "POST") {
    if (world.auditStatus) return json({ message: "audit down" }, world.auditStatus);
    const row = { id: `aud-${world.audit.length + 1}`, occurred_at: "db-now", ...body };
    world.audit.push(row);
    return json([{ id: row.id }], 201);
  }
  if (url.startsWith("https://api.airtable.com/")) {
    if (url.includes(encodeURIComponent("Organisation & Branding"))) return json({ records: [ORG_ROW] });
    if (url.includes(encodeURIComponent("Feature Controls"))) return json({ records: world.features });
    if (url.includes(SETTINGS_PATH)) {
      if (method === "GET") {
        if (world.settingsReadStatus) return json({ error: "boom" }, world.settingsReadStatus);
        return json({ records: world.settings });
      }
      if (method === "POST") {
        if (world.settingsWriteStatus) return json({ error: "boom" }, world.settingsWriteStatus);
        const rec = { id: NEW_REC, fields: Object.fromEntries(Object.entries(body.records[0].fields).filter(([, v]) => v !== null)) };
        world.settings.push(rec);
        return json({ records: [rec] });
      }
      const id = url.split("/").pop()!;
      const rec = world.settings.find((r) => r.id === id);
      const isUndo = calls.filter((c) => c.url.includes(SETTINGS_PATH) && c.method !== "GET").length > 1;
      if (method === "PATCH") {
        if (world.settingsWriteStatus && !isUndo) return json({ error: "boom" }, world.settingsWriteStatus);
        if (isUndo && world.undoStatus) return json({ error: "undo boom" }, world.undoStatus);
        if (!rec) return json({ error: "NOT_FOUND" }, 404);
        for (const [k, v] of Object.entries(body.fields)) {
          if (v === null) delete rec.fields[k];
          else rec.fields[k] = v;
        }
        return json(rec);
      }
      if (method === "DELETE") {
        if (world.undoStatus) return json({ error: "undo boom" }, world.undoStatus);
        world.settings = world.settings.filter((r) => r.id !== id);
        return json({ deleted: true, id });
      }
    }
    return json({ records: [] });
  }
  return json({ error: "unexpected url" }, 598);
}) as typeof fetch;

const deps: SettingsDeps = {
  airtable: { baseId: "appQktredAuGa1X7e", token: "pat-test" },
  grants: { supabaseUrl: "https://dkqubldmfyeuudecxmvh.supabase.co", serviceRoleKey: "service-role-test" },
  clock: () => new Date("2026-09-29T12:00:00.000Z"),
};
const writes = () => calls.filter((c) => c.method !== "GET" && !c.url.includes("/rpc/"));
const settingsWrites = () => calls.filter((c) => c.url.includes(SETTINGS_PATH) && c.method !== "GET");
const parse = (body: unknown): any => {
  try {
    return parseUpdateBody(typeof body === "string" ? body : JSON.stringify(body), isTenantKey);
  } catch {
    return { ok: false, code: "threw" };
  }
};
const upd = async (settings: Record<string, unknown>, reason?: string, caller: any = mgr) => {
  const p = parse({ settings, ...(reason !== undefined ? { reason } : {}) });
  if (!p.ok) throw new Error(`test body invalid: ${JSON.stringify(p)}`);
  return (await updateFinanceSettings(deps, caller, p)) as any;
};

async function main() {
  RETRY_DELAYS_MS.splice(0, RETRY_DELAYS_MS.length, 1, 1, 1, 1, 1);
  SETTINGS_RETRY_DELAYS_MS.splice(0, SETTINGS_RETRY_DELAYS_MS.length, 1, 1, 1, 1, 1);

  // ===== S. Pure Settings domain =====
  {
    const c0 = completeness(EMPTY_SETTINGS);
    ck("S1. Nothing configured -> incomplete, 0/5 required, every required item listed", !c0.complete && c0.requiredTotal === 5 && c0.requiredComplete === 0 && c0.missing.join() === "invoiceLegalName,invoiceAddress,vatRegistered,defaultPaymentTermsDays,coachPaymentDayOfFollowingMonth");
    const cFull = completeness(FULL);
    ck("S2. VAT registered + everything set -> complete 8/8", cFull.complete && cFull.requiredTotal === 8 && cFull.requiredComplete === 8 && cFull.missing.length === 0);
    const regNoDetail = completeness({ ...FULL, vatNumber: null, defaultVatRateBasisPoints: null });
    ck("S3. VAT registered without number/rate -> incomplete, both listed", !regNoDetail.complete && regNoDetail.missing.join() === "vatNumber,defaultVatRateBasisPoints" && regNoDetail.requiredComplete === 6);
    const notReg = { ...FULL, vatRegistered: false, vatNumber: null, defaultVatRateBasisPoints: null, defaultVatTreatment: null };
    ck("S4. Not VAT registered -> VAT detail not required; complete 5/5", completeness(notReg).complete && completeness(notReg).requiredTotal === 5);
    ck("S5. Optional company number never reduces completeness", completeness({ ...FULL, companyNumber: null }).complete);
    ck("S6. Not registered but a VAT number / rate / plus_vat set -> cross-field errors on each", Object.keys(crossFieldErrors({ ...notReg, vatNumber: "GB1", defaultVatRateBasisPoints: 2000, defaultVatTreatment: "plus_vat" })).join() === "vatNumber,defaultVatRateBasisPoints,defaultVatTreatment");
    ck("S7. Not registered + no_vat treatment is consistent", Object.keys(crossFieldErrors({ ...notReg, defaultVatTreatment: "no_vat" })).length === 0);
    ck("S8. Inconsistent settings are never reported complete", !completeness({ ...notReg, vatNumber: "GB1" }).complete);
    ck("S9. effectiveDefaultVat: not registered -> no_vat 0; registered -> configured treatment + rate; unknown -> null", JSON.stringify(effectiveDefaultVat(notReg)) === JSON.stringify({ treatment: "no_vat", rateBasisPoints: 0 }) && JSON.stringify(effectiveDefaultVat(FULL)) === JSON.stringify({ treatment: "vat_included", rateBasisPoints: 2000 }) && effectiveDefaultVat(EMPTY_SETTINGS) === null && effectiveDefaultVat({ ...FULL, defaultVatRateBasisPoints: null }) === null);
    ck("S10. No rate is assumed anywhere: empty settings give no default rate", effectiveDefaultVat({ ...EMPTY_SETTINGS, vatRegistered: true, defaultVatTreatment: "plus_vat" }) === null);
    const round = fromStoredRow(storedRow(FULL)) as any;
    ck("S11. Stored row -> domain round-trip is exact (select labels, numbers, multiline)", round.ok && JSON.stringify(round.state.settings) === JSON.stringify(FULL) && round.state.revision === 3 && round.state.configured);
    ck("S12. Stored unknown select label -> invalid (fails closed, not blank)", !(fromStoredRow(storedRow(FULL, { [FIELD_NAMES.defaultVatTreatment]: "Exempt" })) as any).ok && !(fromStoredRow(storedRow(FULL, { [FIELD_NAMES.vatRegistered]: "Yes" })) as any).ok);
    ck("S13. Stored fractional rate / day 32 / day 7.5 / negative revision -> invalid", [{ [FIELD_NAMES.defaultVatRateBasisPoints]: 2000.5 }, { [FIELD_NAMES.coachPaymentDayOfFollowingMonth]: 32 }, { [FIELD_NAMES.coachPaymentDayOfFollowingMonth]: 7.5 }, { Revision: -1 }].every((o) => !(fromStoredRow(storedRow(FULL, o)) as any).ok));
    ck("S14. Stored cross-field contradiction -> invalid", !(fromStoredRow(storedRow({ ...notReg, vatNumber: "GB1" })) as any).ok);
    ck("S15. Stored blank optional fields read as null (Airtable omits empty cells)", (fromStoredRow(storedRow({ ...FULL, companyNumber: null })) as any).state.settings.companyNumber === null);
    // F6 correction: official invoice numbering settings
    const pu = (settings: Record<string, unknown>) => parseUpdateBody(JSON.stringify({ settings }), isTenantKey) as any;
    ck("SN1. Numbering authority: hub / xero / null accepted; anything else refused", pu({ invoiceNumberAuthority: "hub" }).ok && pu({ invoiceNumberAuthority: "xero" }).ok && pu({ invoiceNumberAuthority: null }).ok && pu({ invoiceNumberAuthority: "sage" }).fields?.invoiceNumberAuthority && pu({ invoiceNumberAuthority: "Hub" }).fields?.invoiceNumberAuthority);
    ck("SN2. Prefix: letters / digits / - _ / only, at most 12, trimmed; quotes / spaces / leading symbol refused", pu({ invoiceNumberPrefix: " INV- " }).patch?.invoiceNumberPrefix === "INV-" && pu({ invoiceNumberPrefix: "TEST-INV/26_" }).ok && ["IN V-", "INV'", "-INV", "ABCDEFGHIJKLM", 'IN"V'].every((v) => pu({ invoiceNumberPrefix: v }).fields?.invoiceNumberPrefix));
    ck("SN3. Next number: whole 1..1,000,000,000 (the value after the last assignable 999,999,999); digits 1..9", pu({ invoiceNumberNext: 1 }).ok && pu({ invoiceNumberNext: 1_000_000_000 }).ok && [0, -1, 1.5, "1001", 1_000_000_001].every((v) => pu({ invoiceNumberNext: v }).fields?.invoiceNumberNext) && pu({ invoiceNumberDigits: 9 }).ok && [0, 10, 2.5].every((v) => pu({ invoiceNumberDigits: v }).fields?.invoiceNumberDigits));
    ck("SN4. Stored authority is a select label (Hub / Xero); an unknown label fails closed", (fromStoredRow(storedRow({ ...FULL, invoiceNumberAuthority: "xero" })) as any).state.settings.invoiceNumberAuthority === "xero" && storedRow(FULL).fields[FIELD_NAMES.invoiceNumberAuthority] === "Hub" && !(fromStoredRow(storedRow(FULL, { [FIELD_NAMES.invoiceNumberAuthority]: "Sage" })) as any).ok && !(fromStoredRow(storedRow(FULL, { [FIELD_NAMES.invoiceNumberNext]: 0 })) as any).ok);
    ck("SN5. Numbering never changes completeness (Xero is optional; issuing checks numbering itself)", completeness({ ...FULL, invoiceNumberAuthority: null, invoiceNumberPrefix: null, invoiceNumberNext: null, invoiceNumberDigits: null }).complete && completeness(FULL).requiredTotal === 8);
    // F17: optional cash safety threshold (pence)
    ck("ST1. Cash safety threshold: whole pence 0..MAX accepted, null clears it; negative / fractional / text refused", pu({ cashSafetyThresholdMinor: 0 }).ok && pu({ cashSafetyThresholdMinor: 500000 }).patch?.cashSafetyThresholdMinor === 500000 && pu({ cashSafetyThresholdMinor: null }).ok && [-1, 1.5, "500000", true].every((v) => pu({ cashSafetyThresholdMinor: v }).fields?.cashSafetyThresholdMinor));
    ck("ST2. Stored threshold round-trips through its own Airtable number field; a fractional / negative stored value fails closed; a blank cell reads as null", storedRow(FULL).fields[FIELD_NAMES.cashSafetyThresholdMinor] === 500000 && FIELD_NAMES.cashSafetyThresholdMinor === "Cash Safety Threshold (Pence)" && !(fromStoredRow(storedRow(FULL, { [FIELD_NAMES.cashSafetyThresholdMinor]: 1.5 })) as any).ok && !(fromStoredRow(storedRow(FULL, { [FIELD_NAMES.cashSafetyThresholdMinor]: -1 })) as any).ok && (fromStoredRow(storedRow({ ...FULL, cashSafetyThresholdMinor: null })) as any).state.settings.cashSafetyThresholdMinor === null);
    ck("ST3. The threshold is optional: it never changes completeness", completeness({ ...FULL, cashSafetyThresholdMinor: null }).complete && completeness(FULL).requiredTotal === 8);
    ck("SV1. Show Cash Summary on Finance Overview (F18): true / false / null accepted; anything else refused", pu({ overviewCashSummaryVisible: true }).ok && pu({ overviewCashSummaryVisible: false }).patch?.overviewCashSummaryVisible === false && pu({ overviewCashSummaryVisible: null }).ok && ["yes", 1, "Shown"].every((v) => pu({ overviewCashSummaryVisible: v }).fields?.overviewCashSummaryVisible));
    ck("SV2. Stored as a select (Shown / Hidden); a blank cell reads as null (= shown by default); an unknown label fails closed", storedRow(FULL).fields[FIELD_NAMES.overviewCashSummaryVisible] === "Hidden" && FIELD_NAMES.overviewCashSummaryVisible === "Show Cash Summary on Finance Overview" && (fromStoredRow(storedRow({ ...FULL, overviewCashSummaryVisible: true })) as any).state.settings.overviewCashSummaryVisible === true && (fromStoredRow(storedRow({ ...FULL, overviewCashSummaryVisible: null })) as any).state.settings.overviewCashSummaryVisible === null && !(fromStoredRow(storedRow(FULL, { [FIELD_NAMES.overviewCashSummaryVisible]: "Maybe" })) as any).ok);
    ck("SV3. The setting is optional: it never changes completeness", completeness({ ...FULL, overviewCashSummaryVisible: null }).complete && completeness(FULL).requiredTotal === 8);
    ck("S16. changedKeys lists only real differences; applyPatch touches only patched keys", changedKeys(FULL, applyPatch(FULL, { defaultPaymentTermsDays: 30, vatNumber: "GB123456789" })).join() === "defaultPaymentTermsDays" && applyPatch(FULL, {}).invoiceLegalName === FULL.invoiceLegalName);
    const ev = buildSettingsAuditEvent({ organisationId: ORG, actorUserId: MGR, recordId: "recX", before: { configured: false, recordId: null, revision: 0, updatedAt: null, settings: EMPTY_SETTINGS }, after: FULL, revision: 1, changed: ["invoiceLegalName"], reason: "r" });
    ck("S17. Audit event for a first write: created, before null, after + revision, context lists changed fields, no client timestamp", ev.event_type === "finance_settings.created" && ev.before === null && (ev.after as any).revision === 1 && JSON.stringify((ev.context as any).changedFields) === '["invoiceLegalName"]' && !("occurred_at" in ev));
  }

  // ===== D. Coach payment day -> calendar date =====
  {
    const d = (day: unknown, y: unknown, m: unknown) => resolveCoachPaymentDate(day, y, m) as any;
    ck("D1. Day 1 -> the 1st", d(1, 2026, 3).date === "2026-03-01");
    ck("D2. Day 7 (TEST baseline) -> the 7th in every month of 2026 and 2028", [2026, 2028].every((y) => Array.from({ length: 12 }, (_, i) => i + 1).every((m) => d(7, y, m).day === 7)));
    ck("D3. Day 28 -> the 28th, including February", d(28, 2026, 2).date === "2026-02-28" && d(28, 2028, 2).date === "2028-02-28");
    ck("D4. Day 29 -> 28 Feb in a non-leap year, 29 Feb in a leap year, 29th elsewhere", d(29, 2026, 2).date === "2026-02-28" && d(29, 2028, 2).date === "2028-02-29" && d(29, 2026, 4).date === "2026-04-29");
    ck("D5. Day 30 -> 28/29 February, 30th in April and in 31-day months", d(30, 2027, 2).date === "2027-02-28" && d(30, 2024, 2).date === "2024-02-29" && d(30, 2026, 4).date === "2026-04-30" && d(30, 2026, 1).date === "2026-01-30");
    ck("D6. Day 31 in 30-day months -> the 30th (Apr, Jun, Sep, Nov)", [4, 6, 9, 11].every((m) => d(31, 2026, m).day === 30));
    ck("D7. Day 31 in 31-day months -> the 31st (Jan, Mar, May, Jul, Aug, Oct, Dec)", [1, 3, 5, 7, 8, 10, 12].every((m) => d(31, 2026, m).day === 31));
    ck("D8. Day 31 in February -> 28 (non-leap) / 29 (leap)", d(31, 2026, 2).date === "2026-02-28" && d(31, 2028, 2).date === "2028-02-29");
    ck("D9. Gregorian century rule, not a hard-coded February: 1900/2100/100 not leap, 2000/4 leap (no 2-digit-year quirk)", d(31, 1900, 2).day === 28 && d(31, 2000, 2).day === 29 && d(31, 2100, 2).day === 28 && daysInMonth(2000, 2) === 29 && daysInMonth(100, 2) === 28 && daysInMonth(4, 2) === 29);
    ck("D10. Invalid configured day (0 / -1 / 32 / 7.5 / NaN / \"7\" / null) -> refused, no date", [0, -1, 32, 7.5, NaN, "7", null, undefined].every((x) => d(x, 2026, 1).ok === false && d(x, 2026, 1).date === undefined));
    ck("D11. Invalid target month / year -> refused", [0, 13, 1.5, "1"].every((m) => d(7, 2026, m).ok === false) && [0, 10000, 2026.5, "2026"].every((y) => d(7, y, 1).ok === false));
    const stored = { ...FULL, coachPaymentDayOfFollowingMonth: 31 };
    const before = JSON.stringify(stored);
    const feb = d(stored.coachPaymentDayOfFollowingMonth, 2026, 2);
    ck("D12. Resolving never changes the stored configured day (31 stays 31 after a 28 Feb resolution)", feb.day === 28 && JSON.stringify(stored) === before && stored.coachPaymentDayOfFollowingMonth === 31);
  }

  // ===== P. POST /settings body parsing =====
  {
    const code = (b: unknown) => (parse(b) as any).code;
    ck("P1. Valid partial body parses; values normalised (trim, CRLF -> LF)", (() => { const p = parse({ settings: { invoiceLegalName: "  Test Ltd ", invoiceAddress: "a\r\nb" }, reason: " setup " }) as any; return p.ok && p.patch.invoiceLegalName === "Test Ltd" && p.patch.invoiceAddress === "a\nb" && p.reason === "setup"; })());
    ck("P2. Empty / non-JSON / array / non-object body -> invalid_body", ["", "  ", "nope", "[]", "5", "null"].every((b) => code(b) === "invalid_body"));
    ck("P3. Missing or empty settings object -> invalid_body", code({}) === "invalid_body" && code({ settings: {} }) === "invalid_body" && code({ settings: [] }) === "invalid_body" && code({ reason: "x" }) === "invalid_body");
    ck("P4. Tenant keys at top level or inside settings -> tenant_param_rejected", code({ organisationId: "ORG-TEST-999", settings: { invoiceLegalName: "x" } }) === "tenant_param_rejected" && code({ settings: { tenant: "x" } }) === "tenant_param_rejected" && code({ settings: { baseId: "apprptFotQuVL1mhs" } }) === "tenant_param_rejected");
    ck("P5. Unknown settings fields -> unexpected_field (Revision, record ids, audit, actor, typos)", ["revision", "Revision", "recordId", "id", "lastChangedBy", "actor_user_id", "audit", "stripeSecretKey", "vatrate"].every((k) => code({ settings: { [k]: 1 } }) === "unexpected_field"));
    ck("P6. Dangerous keys (__proto__, constructor, prototype) -> unexpected_field, never merged", code('{"settings":{"__proto__":{"polluted":1}}}') === "unexpected_field" && code({ settings: { constructor: 1 } }) === "unexpected_field" && ({} as any).polluted === undefined);
    ck("P7. Unknown top-level field -> unexpected_field", code({ settings: { invoiceLegalName: "x" }, force: true }) === "unexpected_field");
    const bad = parse({ settings: { defaultVatRateBasisPoints: 20.5, coachPaymentDayOfFollowingMonth: 32, defaultPaymentTermsDays: "30", vatRegistered: "yes", defaultVatTreatment: "exempt", invoiceLegalName: 5 } }) as any;
    ck("P8. Every invalid field is reported together; nothing partially accepted", bad.code === "invalid_settings" && Object.keys(bad.fields).length === 6 && bad.patch === undefined);
    ck("P9. Coach payment day 1-31 accepted (1, 7, 28, 29, 30, 31); 0 / -1 / 32 / 7.5 / \"7\" / null-ish junk refused; payment terms 0-365", [1, 7, 28, 29, 30, 31].every((d) => (parse({ settings: { coachPaymentDayOfFollowingMonth: d } }) as any).patch?.coachPaymentDayOfFollowingMonth === d) && [0, -1, 32, 7.5, "7", true, [7], {}].every((d) => code({ settings: { coachPaymentDayOfFollowingMonth: d } }) === "invalid_settings") && parse({ settings: { defaultPaymentTermsDays: 0 } }).ok && code({ settings: { defaultPaymentTermsDays: 366 } }) === "invalid_settings");
    ck("P10. VAT rate in whole basis points 0-10000; floats and strings refused", parse({ settings: { defaultVatRateBasisPoints: 0 } }).ok && parse({ settings: { defaultVatRateBasisPoints: 10000 } }).ok && ["20", 20.0001, 10001, -1].every((v) => code({ settings: { defaultVatRateBasisPoints: v } }) === "invalid_settings"));
    ck("P11. null clears a field; blank text clears to null", (parse({ settings: { companyNumber: null } }) as any).patch.companyNumber === null && (parse({ settings: { companyNumber: "   " } }) as any).patch.companyNumber === null);
    ck("P12. Over-long text, control characters, >8 address lines refused", code({ settings: { invoiceLegalName: "x".repeat(201) } }) === "invalid_settings" && code({ settings: { invoiceLegalName: "a\u0000b" } }) === "invalid_settings" && code({ settings: { invoiceLegalName: "a\nb" } }) === "invalid_settings" && code({ settings: { invoiceAddress: "1\n2\n3\n4\n5\n6\n7\n8\n9" } }) === "invalid_settings");
    ck("P13. reason must be text <= 500 chars", code({ settings: { invoiceLegalName: "x" }, reason: 5 }) === "invalid_settings" && code({ settings: { invoiceLegalName: "x" }, reason: "r".repeat(501) }) === "invalid_settings" && (parse({ settings: { invoiceLegalName: "x" }, reason: "" }) as any).reason === null);
  }

  // ===== G. GET /settings =====
  {
    reset();
    let r: any = await getFinanceSettings(deps, mgr);
    ck("G1. Missing configuration -> 200 configured:false, revision 0, all required items missing", r.status === "ok" && r.body.configured === false && r.body.revision === 0 && r.body.completeness.requiredComplete === 0 && r.body.access === "manage");
    reset({ grants: { [MGR]: [g("view")] }, settings: [storedRow(FULL)] });
    r = await getFinanceSettings(deps, mgr);
    ck("G2. View grant can read the stored settings (complete 8/8)", r.status === "ok" && r.body.access === "view" && r.body.settings.vatNumber === "GB123456789" && r.body.completeness.complete);
    ck("G3. Reads write nothing and create no audit event", writes().length === 0 && world.audit.length === 0 && !calls.some((c) => c.url.includes("/rpc/")));
    reset({ grants: { [MGR]: [] } });
    r = await getFinanceSettings(deps, mgr);
    ck("G4. No grant -> 403 finance_access_denied (Settings table never read)", r.httpStatus === 403 && r.code === "finance_access_denied" && !calls.some((c) => c.url.includes(SETTINGS_PATH)));
    reset({ grants: { [COACH]: [g("manage")] } });
    r = await getFinanceSettings(deps, { ...mgr, userId: COACH, role: "coach" });
    const rp: any = await getFinanceSettings(deps, { ...mgr, userId: COACH, role: "parent" });
    ck("G5. Coach (even with a grant) / Parent -> 403 management_required", r.code === "management_required" && rp.code === "management_required");
    reset({ features: [FIN_OFF] });
    r = await getFinanceSettings(deps, mgr);
    ck("G6. Module off -> 403 finance_module_disabled", r.httpStatus === 403 && r.code === "finance_module_disabled");
    reset({ settings: [storedRow(FULL, { Organisation: [OTHER_REC] }, "recOtherSettings1")] });
    r = await getFinanceSettings(deps, mgr);
    ck("G7. Another organisation's settings row is never used (isolation) -> configured:false", r.status === "ok" && r.body.configured === false);
    reset({ settings: [storedRow(FULL), storedRow(FULL, {}, "recSettingsRow002")] });
    r = await getFinanceSettings(deps, mgr);
    ck("G8. Two rows for the organisation -> 409 finance_settings_ambiguous (never picks one)", r.httpStatus === 409 && r.code === "finance_settings_ambiguous");
    reset({ settings: [storedRow(FULL, { Organisation: [ORG_REC, OTHER_REC] })] });
    r = await getFinanceSettings(deps, mgr);
    ck("G9. A row linked to two organisations -> 409 finance_settings_invalid", r.httpStatus === 409 && r.code === "finance_settings_invalid");
    reset({ settings: [storedRow(FULL, { [FIELD_NAMES.defaultVatRateBasisPoints]: 17.5 })] });
    r = await getFinanceSettings(deps, mgr);
    ck("G10. Malformed stored value -> 409 finance_settings_invalid naming the field (not treated as missing)", r.httpStatus === 409 && r.code === "finance_settings_invalid" && r.error.includes("Default VAT Rate (Basis Points)"));
    reset({ settingsReadStatus: 500 });
    r = await getFinanceSettings(deps, mgr);
    ck("G11. Settings store failure -> 503 finance_settings_unavailable (distinct from missing)", r.httpStatus === 503 && r.code === "finance_settings_unavailable");
  }

  // ===== U. UPDATE =====
  {
    reset({ grants: { [MGR]: [g("view")] } });
    let r = await upd({ invoiceLegalName: "X" });
    ck("U1. View grant cannot update -> 403 finance_manage_required; no lock, no write, no event", r.httpStatus === 403 && r.code === "finance_manage_required" && calls.every((c) => !c.url.includes("/rpc/")) && writes().length === 0);

    reset({ grants: { [MGR]: [] } });
    r = await upd({ invoiceLegalName: "X" });
    ck("U2. No grant -> 403 finance_access_denied; nothing written", r.code === "finance_access_denied" && writes().length === 0);

    reset({ features: [FIN_OFF] });
    r = await upd({ invoiceLegalName: "X" });
    ck("U3. Module off -> 403 finance_module_disabled; nothing written", r.code === "finance_module_disabled" && writes().length === 0);

    reset();
    r = await upd({ invoiceLegalName: "Test Coaching Ltd", coachPaymentDayOfFollowingMonth: 7 }, "Initial setup");
    const created = world.settings[0];
    ck("U4. First valid write creates ONE row owned by the caller's organisation (link + FINSET id), revision 1", r.status === "ok" && r.body.changed && settingsWrites().length === 1 && settingsWrites()[0].method === "POST" && world.settings.length === 1 && JSON.stringify(created.fields.Organisation) === JSON.stringify([ORG_REC]) && created.fields["Finance Settings ID"] === `FINSET-${ORG}` && created.fields.Revision === 1);
    const ev = world.audit[0];
    ck("U5. Exactly one audit event: created, org + actor from the profile, before null, after = new settings", world.audit.length === 1 && ev.event_type === "finance_settings.created" && ev.organisation_id === ORG && ev.actor_user_id === MGR && ev.before === null && ev.after.settings.invoiceLegalName === "Test Coaching Ltd" && ev.after.revision === 1 && ev.reason === "Initial setup" && ev.entity_type === "finance_settings" && ev.record_id === NEW_REC);
    ck("U6. Response is the resulting config: 3/5 complete, revision 1, server timestamp", r.body.revision === 1 && r.body.updatedAt === "2026-09-29T12:00:00.000Z" && r.body.completeness.requiredComplete === 2 && r.body.completeness.requiredTotal === 5);
    ck("U7. Lock acquired and released exactly once", calls.filter((c) => c.url.includes("acquire_finance_settings_lock")).length === 1 && world.releases === 1 && world.lockHeld === null);

    calls = [];
    r = await upd({ vatRegistered: true, vatNumber: "GB123456789", defaultVatRateBasisPoints: 2000, defaultVatTreatment: "plus_vat" });
    const patchCall = settingsWrites()[0];
    ck("U8. Second write PATCHes only the changed fields + revision/actor/time", settingsWrites().length === 1 && patchCall.method === "PATCH" && Object.keys(patchCall.body.fields).sort().join() === ["VAT Registration", "VAT Number", "Default VAT Rate (Basis Points)", "Default VAT Treatment", "Revision", "Last Changed By User ID", "Last Changed At"].sort().join() && patchCall.body.fields.Revision === 2);
    const ev2 = world.audit[1];
    ck("U9. Second event: updated, before = previous settings (rev 1), after = merged (rev 2), changed fields listed", world.audit.length === 2 && ev2.event_type === "finance_settings.updated" && ev2.before.revision === 1 && ev2.before.settings.vatRegistered === null && ev2.after.settings.vatRegistered === true && ev2.after.settings.invoiceLegalName === "Test Coaching Ltd" && ev2.context.changedFields.length === 4);

    calls = [];
    r = await upd({ vatNumber: "GB123456789" });
    ck("U10. No-op update -> 200 changed:false; no write, no audit event", r.status === "ok" && r.body.changed === false && settingsWrites().length === 0 && world.audit.length === 2 && r.body.revision === 2);

    calls = [];
    r = await upd({ vatRegistered: false });
    ck("U11. Cross-field invalid (not registered while a VAT number is set) -> 400 invalid_settings; no write, no event", r.httpStatus === 400 && r.code === "invalid_settings" && Object.keys(r.fields).includes("vatNumber") && settingsWrites().length === 0 && world.audit.length === 2 && world.lockHeld === null);

    calls = [];
    r = await upd({ vatRegistered: false, vatNumber: null, defaultVatRateBasisPoints: null, defaultVatTreatment: "no_vat" }, "Deregistered");
    ck("U12. Coherent multi-field change succeeds as ONE write and ONE event", r.status === "ok" && settingsWrites().length === 1 && world.audit.length === 3 && world.settings[0].fields["VAT Number"] === undefined && world.settings[0].fields["VAT Registration"] === "Not registered");

    const snapshot = JSON.stringify(world.settings);
    const auditBefore = world.audit.length;
    world.lockMode = "busy";
    calls = [];
    r = await upd({ defaultPaymentTermsDays: 30 });
    ck("U13. Lock held elsewhere -> 409 finance_settings_busy; no read-modify-write", r.httpStatus === 409 && r.code === "finance_settings_busy" && settingsWrites().length === 0 && world.audit.length === auditBefore);
    world.lockMode = "error";
    r = await upd({ defaultPaymentTermsDays: 30 });
    ck("U14. Lock store failure -> 503 finance_settings_unavailable; nothing written", r.httpStatus === 503 && JSON.stringify(world.settings) === snapshot);
    world.lockMode = "ok";

    world.settingsWriteStatus = 422;
    calls = [];
    r = await upd({ defaultPaymentTermsDays: 30 });
    ck("U15. Airtable write fails -> 503; no audit event; lock released", r.httpStatus === 503 && world.audit.length === auditBefore && JSON.stringify(world.settings) === snapshot && world.lockHeld === null);
    world.settingsWriteStatus = undefined;

    world.auditStatus = 500;
    calls = [];
    r = await upd({ defaultPaymentTermsDays: 30, invoiceLegalName: "Renamed Ltd" });
    ck("U16. Audit write fails on an update -> the patch is undone (before values + revision restored), 503, no event", r.httpStatus === 503 && r.code === "finance_audit_unavailable" && world.audit.length === auditBefore && JSON.stringify(world.settings) === snapshot);
    world.undoStatus = 500;
    calls = [];
    r = await upd({ defaultPaymentTermsDays: 31 });
    ck("U17. Audit AND undo fail -> 500 finance_settings_unaudited (loud, never reported as success)", r.httpStatus === 500 && r.code === "finance_settings_unaudited");
    world.auditStatus = undefined;
    world.undoStatus = undefined;

    reset({ auditStatus: 500 });
    r = await upd({ invoiceLegalName: "First Ltd" });
    ck("U18. Audit write fails on a first write -> the created row is deleted, 503, no event", r.httpStatus === 503 && world.settings.length === 0 && world.audit.length === 0 && settingsWrites().map((c) => c.method).join() === "POST,DELETE");

    reset({ settings: [storedRow(FULL, { [FIELD_NAMES.coachPaymentDayOfFollowingMonth]: 32 })] });
    r = await upd({ coachPaymentDayOfFollowingMonth: 7 });
    ck("U19. Stored settings invalid -> 409; update refused (no overwrite of unknown state), no event", r.httpStatus === 409 && r.code === "finance_settings_invalid" && settingsWrites().length === 0 && world.audit.length === 0 && world.lockHeld === null);

    reset({ settings: [storedRow(FULL, { Organisation: [OTHER_REC] }, "recOtherSettings1")] });
    r = await upd({ invoiceLegalName: "Mine Ltd" });
    ck("U20. Isolation: another organisation's row is never patched; caller's own row is created", r.status === "ok" && world.settings.find((x) => x.id === "recOtherSettings1")!.fields["Invoice Legal Name"] === "Test Coaching Ltd" && settingsWrites()[0].method === "POST");

    reset({ grants: { [COACH]: [g("manage")] } });
    r = await upd({ invoiceLegalName: "X" }, undefined, { ...mgr, userId: COACH, role: "coach" });
    ck("U21. Coach holding a manage grant -> 403 management_required; nothing written", r.code === "management_required" && writes().length === 0);
  }

  // ===== C. Contract =====
  {
    reset({ settings: [storedRow(FULL)] });
    const r: any = await getFinanceSettings(deps, mgr);
    const s = JSON.stringify(r.body);
    ck("C1. GET body keys are exactly the documented contract", Object.keys(r.body).join() === "contract,organisation,access,configured,revision,updatedAt,settings,completeness" && r.body.contract === "finance-settings-v1");
    ck("C2. settings keys are exactly the nine Settings fields", Object.keys(r.body.settings).join() === SETTINGS_KEYS.join());
    ck("C3. No Airtable ids, user ids, audit internals, grant data or keys in the body", !/rec[A-Za-z0-9]{14}|app[A-Za-z0-9]{14}/.test(s) && !s.includes(MGR) && !/service|audit|actor|grant|token|Last Changed By/i.test(s));
    reset();
    const u: any = await upd({ invoiceLegalName: "X Ltd" });
    const su = JSON.stringify(u.body);
    ck("C4. UPDATE body = GET contract + changed; no record ids / actor / audit id", Object.keys(u.body).join() === "contract,organisation,access,configured,revision,updatedAt,settings,completeness,changed" && !su.includes(NEW_REC) && !su.includes(MGR) && !su.includes("aud-"));
  }

  // ===== Z. Code / drift =====
  {
    const canon = (f: string) => readFileSync(join(CANON, f), "utf8");
    const support = (f: string) => readFileSync(join(HERE, f), "utf8");
    const stripHeader = (s: string) => s.replace(/^\/\*\*\n \* Test-suite copy[\s\S]*?\*\/\n/, "");
    ck("Z1. finance-money / finance-effective-dating / finance-settings support copies are byte-identical", ["finance-money.ts", "finance-effective-dating.ts", "finance-settings.ts"].every((f) => stripHeader(support(f)) === canon(f)));
    ck("Z2. finance-settings-repository support copy = canonical with only the repository import adjusted", stripHeader(support("finance-settings-repository.ts")) === canon("finance-settings-repository.ts").replace('"./repository.ts"', '"./finance-repository.ts"'));
    ck("Z3. finance-settings-orchestrator support copy = canonical with only the orchestrator import adjusted", stripHeader(support("finance-settings-orchestrator.ts")) === canon("finance-settings-orchestrator.ts").replace('"./orchestrator.ts"', '"./finance-orchestrator.ts"'));
    const code = (f: string) => canon(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    ck("Z4. Kernel + Settings domain are pure: no fetch, Deno, Supabase or Airtable calls", ["finance-money.ts", "finance-effective-dating.ts", "finance-settings.ts"].every((f) => !/fetch\(|Deno\.|createClient|api\.airtable\.com/.test(code(f))));
    const noStrings = (src: string) => src.replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
    ck("Z5. No 20% (or any VAT rate) is hard-coded in kernel or Settings logic (messages aside)", !/\b2000\b|\b0\.2\b|\b20\s*%|\b1\.2\b/.test(noStrings(code("finance-money.ts") + code("finance-settings.ts"))));
    ck("Z6. Money kernel uses no floating-point rounding helpers (Math.round / toFixed / parseFloat)", !/Math\.round|toFixed|parseFloat/.test(code("finance-money.ts")));
    const repo = code("finance-settings-repository.ts");
    ck("Z7. The audit table is only ever POSTed to (no PATCH/DELETE path to finance_audit_events)", (repo.match(/AUDIT_TABLE/g) ?? []).length === 2 && !/AUDIT_TABLE[^\n]*method:\s*"(PATCH|DELETE)"/.test(repo));
    ck("Z8. The only Airtable DELETE is the compensating deleteCreatedSettingsRow", (repo.match(/method: "DELETE"/g) ?? []).length === 1 && /export async function deleteCreatedSettingsRow[\s\S]*?method: "DELETE"/.test(repo));
    ck("Z9. Audit events never carry a client timestamp (occurred_at is the database clock)", !/occurred_at/.test(code("finance-settings.ts") + repo));
    const idx = canon("index.ts");
    ck("Z10. Routes: F1 access/write-check unchanged + settings GET/POST only (no debug / VAT endpoint)", /const ROUTES: Record<string, string\[\]> = \{ access: \["GET"\], "write-check": \["POST"\], settings: \["GET", "POST"\] \};/.test(idx));
    ck("Z11. POST /settings body is parsed (tenant/unknown/invalid -> 400) before any authorisation or write", idx.indexOf("parseUpdateBody(") > idx.indexOf("checkQueryKeys(") && idx.indexOf("parseUpdateBody(") < idx.indexOf("updateFinanceSettings(deps"));
    ck("Z12. Settings reuse F1 authorizeFinance (read for GET, manage for UPDATE) - no new auth path", /authorizeFinance\(deps, caller, "read"\)/.test(canon("finance-settings-orchestrator.ts")) && /authorizeFinance\(deps, caller, "manage"\)/.test(canon("finance-settings-orchestrator.ts")) && !/createClient|profiles/.test(code("finance-settings-orchestrator.ts")));
    ck("Z13. F1 repository.ts is still read-only and F1 files are untouched by F2 wiring", !/method\s*:|"POST"|"PATCH"|"DELETE"/.test(code("repository.ts")) && !/finance-settings/.test(canon("orchestrator.ts") + canon("finance-access.ts") + canon("repository.ts")));
    const all = ["finance-money.ts", "finance-effective-dating.ts", "finance-settings.ts", "finance-settings-repository.ts", "finance-settings-orchestrator.ts"].map(canon).join("\n");
    ck("Z14. No Josh Evans naming, Sheets/Stripe/Xero calls or credential fields in F2 code", !/josh|evans/i.test(all) && !/sheets\.googleapis|api\.stripe|api\.xero|secret_?key|client_?secret|access_?token|refresh_?token/i.test(all));
  }

  for (const [s, n, e] of R) console.log(`${s}  ${n}${e && s === "FAIL" ? `  [${e}]` : ""}`);
  const passed = R.filter((r) => r[0] === "PASS").length;
  console.log(`\n${passed}/${R.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
