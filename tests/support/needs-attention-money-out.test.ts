// Unit + integration tests for Finance Foundation F16 - Money Out in Needs
// Attention (see TEST-ENV.md "Finance Foundation - F16"):
//
//   PD   outgoing payment due today / overdue (ATT-049 / ATT-050): confirmed
//        F13 / F14 instalments, remaining after cash + supplier credit (brief 1-8)
//   EM   F15 employment months: confirmed due / overdue, paid (brief 9-11)
//   ES   estimate review (ATT-051 / 052 / 053): window, escalation, mutual
//        exclusivity, confirm / Use Estimate / paid (brief 12-19)
//   SET  F2 "Estimate Reminder Days" (organisation setting, Finance baseline 3)
//   AC   access: Manage / View / none / module off / Coach-Parent / grant
//        lookup failure (brief 20-26)
//   SN   snooze = exact-case exception only; never changes Finance truth (27-30)
//   ID   case identity + no duplicates (31-34)
//   DT   organisation-local dates + overdue-day count (35-36)
//   PF   bounded reads: each Finance source once, paged, one pass, no per-source read
//   DQ   unreadable / foreign / unavailable Finance data -> loud + incomplete
//   DR   drift: copied blocks verbatim, allowlisted reads, registry vs catalogue,
//        F12 Coach Months excluded, no write path
//
// Request-level behaviour runs through the REAL orchestrator + the deployed
// registry against an in-memory Airtable (writes ONLY to Exceptions) and an
// in-memory Supabase REST (GET only). Finance rows are produced by Finance's
// OWN row builders (F13 supplierRow / instalmentRow, F15 versionRow / itemRow),
// so they are exactly what F13 / F14 / F15 store.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirtableRecord } from "./needs-attention-engine.ts";
import { createException, getCases, type Caller, type Deps } from "./needs-attention-orchestrator.ts";
import { IMPLEMENTED_EVALUATORS } from "./needs-attention-registry.ts";
import { CONFIG_TABLES, FINANCE_MAX_PAGES, FINANCE_PAGE_SIZE, FINANCE_SOURCES, RETRY_DELAYS_MS } from "./needs-attention-repository.ts";
import type { LockClient } from "./needs-attention-lock-client.ts";
import type { FinanceAccess } from "./needs-attention-finance.ts";
import { MONEY_OUT_RULES, MONEY_OUT_SOURCES, MONEY_OUT_TABLES, bucketOf, moneyOutPassStats, runMoneyOutPass } from "./needs-attention-money-out.ts";
import { type Instalment, type Supplier, remainingOf } from "./finance-suppliers.ts";
import { instalmentRow, supplierRow } from "./finance-suppliers-repository.ts";
import type { EmploymentItem, EmploymentVersion } from "./finance-overheads.ts";
import { itemRow, versionRow } from "./finance-overheads-repository.ts";
import { DEFAULT_ESTIMATE_REMINDER_DAYS, EMPTY_SETTINGS, ESTIMATE_REMINDER_DAYS_MAX, FIELD_VALIDATORS, SETTINGS_KEYS, SETTINGS_TABLE, estimateReminderDaysOf, fromStoredRow, toStoredFields } from "./finance-settings.ts";

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FUNCS = join(HERE, "..", "..", "supabase", "functions-test");
const canon = (p: string) => readFileSync(join(FUNCS, p), "utf8");

// ---------------------------------------------------------------------
// Fixtures (NOW = Fri 2 Oct 2026 11:00 BST)
// ---------------------------------------------------------------------
const rid = (tag: string) => "rec" + (tag + "00000000000000").slice(0, 14);
const ORG = rid("OrgTest1");
const ORG2 = rid("OrgOther");
const ORG_ID = "ORG-TEST-001";
const ORG2_ID = "ORG-TEST-999";
const TZ = "Europe/London";
const NOW = new Date("2026-10-02T10:00:00.000Z");
const MGR = "285f819e-e0d4-4257-8121-5f16781e97ba";
const T0 = "2026-09-01T09:00:00.000Z";
const hex = (n: number) => n.toString(16).toUpperCase().padStart(12, "0");

const supplier = (n: number, name: string, type = "venue", org = ORG_ID): Supplier => ({
  organisationId: org, supplierId: `FSU-${hex(n)}`, name, supplierType: type as any, active: true, contactName: null, contactEmail: null, contactPhone: null, vatTreatment: null, notes: null, venueRecordId: null,
  revision: 1, createdAt: T0, createdBy: MGR, updatedAt: T0, updatedBy: MGR,
});
const S1 = supplier(1, "ZZTEST F16 Venue");
const S2 = supplier(2, "ZZTEST F16 Contractor", "contractor");
const SX = supplier(99, "Other Org Supplier", "venue", ORG2_ID);

let instN = 0;
function inst(o: { s?: Supplier; due: string; amount: number; state?: "estimated" | "confirmed"; paid?: number; credited?: number; cancelled?: boolean; originalDue?: string; org?: string }): Instalment {
  const n = ++instN;
  const s = o.s ?? S1;
  return {
    organisationId: o.org ?? ORG_ID, instalmentId: `FSI-${hex(n)}`, agreementId: `FSA-${hex(s === S2 ? 2 : 1)}`, supplierId: s.supplierId, sequence: n, originalDueDate: o.originalDue ?? o.due, dueDate: o.due,
    plannedMinor: o.amount, amountDueMinor: o.amount, amountState: o.state ?? "confirmed", paidMinor: o.paid ?? 0, creditedMinor: o.credited ?? 0, splitFromInstalmentId: null, note: null,
    cancelledAt: o.cancelled ? "2026-09-20T09:00:00.000Z" : null, cancelledBy: o.cancelled ? MGR : null, cancelReason: o.cancelled ? "agreement changed" : null, createdAt: T0, createdBy: MGR,
  };
}
// Supplier / venue instalments
const I_TODAY = inst({ due: "2026-10-02", amount: 50000 }); // 1: confirmed, due today
const I_OVER = inst({ due: "2026-09-25", amount: 30000 }); // 2: overdue 7 days
const I_FUT = inst({ due: "2026-10-10", amount: 20000 }); // 3: future confirmed
const I_PAID = inst({ due: "2026-09-15", amount: 25000, paid: 25000 }); // 4: paid
const I_CANC = inst({ due: "2026-09-10", amount: 40000, cancelled: true }); // 5: cancelled
const I_PART = inst({ s: S2, due: "2026-09-20", amount: 50000, paid: 20000 }); // 6: partial, 300.00 left
const I_CRED = inst({ due: "2026-09-28", amount: 40000, credited: 10000 }); // 7: credit 100.00 applied, 300.00 left
const I_CREDFULL = inst({ due: "2026-09-28", amount: 40000, credited: 40000 }); // 8: settled by credit
const I_CASHCRED = inst({ due: "2026-09-26", amount: 50000, paid: 30000, credited: 20000 }); // settled by cash + credit
const I_MOVED = inst({ due: "2026-09-29", originalDue: "2026-10-20", amount: 15000 }); // due date moved earlier: overdue 3
// Estimated supplier costs
const E_SOON = inst({ s: S2, due: "2026-10-04", amount: 31500, state: "estimated" }); // 12: in window (2 days)
const E_FAR = inst({ s: S2, due: "2026-10-09", amount: 31500, state: "estimated" }); // 13: outside window (7 days)
const E_TODAY = inst({ due: "2026-10-02", amount: 8000, state: "estimated" }); // 14: still estimated today
const E_OVER = inst({ due: "2026-09-30", amount: 12000, state: "estimated" }); // 15: estimate overdue (2 days)
const I_X = inst({ s: SX, due: "2026-09-01", amount: 99900, org: ORG2_ID }); // another organisation's overdue instalment

// F15 employment
const ver = (n: number, o: { emp: number; name: string; annual: number; payDay: number; start: string; end?: string | null; from: string; pension?: number | null; ni?: number | null; org?: string }): EmploymentVersion => ({
  organisationId: o.org ?? ORG_ID, versionId: `FEV-${hex(n)}`, employmentId: `FEM-${hex(o.emp)}`, supersedesVersionId: null, personRef: null, personName: o.name, categoryId: "FOC-000000000001",
  annualSalaryMinor: o.annual, payDay: o.payDay, startDate: o.start, endDate: o.end ?? null, effectiveFromMonth: o.from, pensionEstimateMinor: o.pension ?? null, niPayeEstimateMinor: o.ni ?? null, notes: null, reason: null, createdAt: T0, createdBy: MGR,
});
const item = (n: number, v: EmploymentVersion, month: string, o: { due: string; amount: number; paid?: boolean }): EmploymentItem => ({
  organisationId: v.organisationId, itemId: `FEI-${hex(n)}`, employmentId: v.employmentId, month, versionId: v.versionId, salaryMinor: o.amount, pensionEstimateMinor: 0, niPayeEstimateMinor: 0, estimateTotalMinor: o.amount, amountDueMinor: o.amount,
  usedEstimate: true, expectedPaymentDate: o.due, confirmedAt: T0, confirmedBy: MGR, confirmReason: null, paidMinor: o.paid ? o.amount : 0, paidDate: o.paid ? o.due : null, paymentMethod: null, paymentReference: null, paymentNote: null,
  paidAt: o.paid ? `${o.due}T12:00:00.000Z` : null, paidBy: o.paid ? MGR : null,
});
const V1 = ver(1, { emp: 1, name: "ZZTEST F16 Salaried Coach", annual: 3000000, payDay: 28, start: "2026-08-01", from: "2026-08", pension: 7500, ni: 21000 }); // 2785.00 / month
const IT1_AUG = item(1, V1, "2026-08", { due: "2026-08-28", amount: 278500, paid: true }); // 11: paid
const IT1_SEP = item(2, V1, "2026-09", { due: "2026-09-28", amount: 265000 }); // 10: confirmed, overdue 4
const V2 = ver(2, { emp: 2, name: "ZZTEST F16 Office Manager", annual: 2400000, payDay: 2, start: "2026-09-01", from: "2026-09" }); // Sep est overdue, Oct est due today
const V3 = ver(3, { emp: 3, name: "ZZTEST F16 Admin", annual: 1200000, payDay: 2, start: "2026-10-01", from: "2026-10" });
const IT3_OCT = item(3, V3, "2026-10", { due: "2026-10-02", amount: 100000 }); // 9: confirmed, due today
const V4 = ver(4, { emp: 4, name: "ZZTEST F16 Groundsman", annual: 1800000, payDay: 4, start: "2026-10-01", from: "2026-10" }); // Oct estimate due in 2 days
const V5 = ver(5, { emp: 5, name: "ZZTEST F16 Mid-month Starter", annual: 1200000, payDay: 30, start: "2026-09-10", from: "2026-09" }); // Sep part month, estimate overdue
const VX = ver(99, { emp: 99, name: "Other Org Person", annual: 1200000, payDay: 1, start: "2026-01-01", from: "2026-01", org: ORG2_ID });

interface Db { suppliers: Supplier[]; instalments: Instalment[]; versions: EmploymentVersion[]; items: EmploymentItem[] }
const STD = (): Db => ({
  suppliers: [S1, S2, SX],
  instalments: [I_TODAY, I_OVER, I_FUT, I_PAID, I_CANC, I_PART, I_CRED, I_CREDFULL, I_CASHCRED, I_MOVED, E_SOON, E_FAR, E_TODAY, E_OVER, I_X].map((i) => ({ ...i })),
  versions: [V1, V2, V3, V4, V5, VX],
  items: [IT1_AUG, IT1_SEP, IT3_OCT].map((i) => ({ ...i })),
});
let db: Db = STD();
const dbRows = (table: string): Record<string, any>[] => {
  if (table === "finance_suppliers") return db.suppliers.map(supplierRow);
  if (table === "finance_supplier_instalments") return db.instalments.map(instalmentRow);
  if (table === "finance_employment_versions") return db.versions.map(versionRow);
  if (table === "finance_employment_items") return db.items.map(itemRow);
  throw new Error(`unexpected table ${table}`);
};

// Catalogue: the five F16 rows exactly as created in TEST (Active here) + ATT-047 (prior Finance rule, unchanged).
const SNAP = JSON.parse(readFileSync(join(HERE, "needs-attention-catalogue.snapshot.json"), "utf8")).records as AirtableRecord[];
const SNAP_F16 = SNAP.filter((r) => /^ATT-05[0-3]|^ATT-049/.test(r.fields["Rule ID"]));
const F16_RULES: AirtableRecord[] = SNAP_F16.map((r) => ({ id: r.id, fields: { ...r.fields, "Evaluation Status": "Active" } }));
const RULE_OVERDUE = SNAP.find((r) => r.fields["Rule ID"] === "ATT-047")!;
const enable = (r: AirtableRecord, on = true, allowOverride = true): AirtableRecord => ({ id: rid("Set" + r.fields["Rule ID"].slice(4)), fields: { Organisation: [ORG], Rule: [r.id], ...(on ? { Enabled: true } : {}), ...(allowOverride ? { "Allow Override": true } : {}) } });
const settingsRow = (days: number | null, org = ORG): AirtableRecord => ({
  id: rid("FinSet" + org.slice(3, 7)),
  fields: Object.fromEntries(Object.entries({ "Finance Settings ID": `FINSET-${org}`, Organisation: [org], ...toStoredFields({ ...EMPTY_SETTINGS, estimateReminderDays: days }, SETTINGS_KEYS), Revision: 1 }).filter(([, v]) => v !== null && v !== undefined)),
});

// ---------------------------------------------------------------------
// In-memory Airtable (writes ONLY to Exceptions) + Supabase REST (GET only)
// ---------------------------------------------------------------------
let tables: Record<string, AirtableRecord[]> = {};
let requests: { method: string; table: string }[] = [];
let sbRequests: { method: string; table: string; params: URLSearchParams }[] = [];
let sbFail: Record<string, number> = {};
let sbLeakForeign = false;
let sbBig = 0;
let excN = 0;
const EXC = CONFIG_TABLES.exceptions;
(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  const u = new URL(url);
  if (u.hostname !== "api.airtable.com") {
    const table = u.pathname.split("/").pop()!;
    sbRequests.push({ method, table, params: u.searchParams });
    if (method !== "GET") throw new Error(`Illegal Supabase ${method} ${table}`);
    if (sbFail[table]) return new Response("boom", { status: sbFail[table] });
    const org = (u.searchParams.get("organisation_id") ?? "").replace(/^eq\./, "");
    let rows = sbBig && table === "finance_supplier_instalments" ? Array.from({ length: sbBig }, (_, k) => instalmentRow(inst({ due: "2027-12-01", amount: 100 }))) : dbRows(table);
    rows = rows.filter((r) => sbLeakForeign || r.organisation_id === org);
    if (u.searchParams.get("cancelled_at") === "is.null") rows = rows.filter((r) => r.cancelled_at === null);
    const off = Number(u.searchParams.get("offset") ?? 0), lim = Number(u.searchParams.get("limit") ?? 1e9);
    return new Response(JSON.stringify(rows.slice(off, off + lim)), { status: 200 });
  }
  const parts = u.pathname.split("/");
  const table = decodeURIComponent(parts[3]);
  requests.push({ method, table });
  if (method === "GET") return new Response(JSON.stringify({ records: (tables[table] ?? []).map((r) => ({ id: r.id, fields: r.fields })) }), { status: 200 });
  if (table !== EXC || (method !== "POST" && method !== "PATCH")) throw new Error(`Illegal write ${method} ${table}`);
  const body = JSON.parse(String(init?.body ?? "{}"));
  const fields = Object.fromEntries(Object.entries(body.fields).filter(([, v]) => v !== false && v !== null && v !== ""));
  const rec = { id: rid("Exc" + String(++excN).padStart(4, "0")), fields };
  tables[EXC] = [...(tables[EXC] ?? []), rec];
  return new Response(JSON.stringify(rec), { status: 200 });
};
RETRY_DELAYS_MS.length = 0;
let tokN = 0;
const held = new Map<string, string>();
const fakeLock: LockClient = {
  async acquire(key) {
    if (held.has(key)) return null;
    const t = `${String(++tokN).padStart(8, "0")}-aaaa-4000-8000-000000000000`;
    held.set(key, t);
    return t;
  },
  async release(key, token) {
    if (held.get(key) !== token) return false;
    held.delete(key);
    return true;
  },
};

interface World { financeOn?: boolean; rules?: AirtableRecord[]; settings?: AirtableRecord[]; finSettings?: AirtableRecord[]; tz?: string; exceptions?: AirtableRecord[] }
function world(o: World = {}) {
  tables = {
    [CONFIG_TABLES.rules]: o.rules ?? [...F16_RULES, RULE_OVERDUE],
    [CONFIG_TABLES.settings]: o.settings ?? F16_RULES.map((r) => enable(r)),
    [EXC]: o.exceptions ?? [],
    [CONFIG_TABLES.features]: [{ id: rid("FeatFin"), fields: o.financeOn === false ? { "Feature Key": "module_finance" } : { "Feature Key": "module_finance", Enabled: true } }],
    [CONFIG_TABLES.organisations]: [
      { id: ORG, fields: { "Organisation ID": ORG_ID, Active: true, Timezone: o.tz ?? TZ, "Organisation Name": "Test Org" } },
      { id: ORG2, fields: { "Organisation ID": ORG2_ID, Active: true, Timezone: TZ, "Organisation Name": "Other Org" } },
    ],
    [SETTINGS_TABLE]: o.finSettings ?? [],
  };
  requests = [];
  sbRequests = [];
  sbFail = {};
  sbLeakForeign = false;
  sbBig = 0;
}

const MANAGER: Caller = { userId: MGR, role: "management", active: true, organisationId: ORG_ID, displayName: "Test Manager" };
const STORE = { supabaseUrl: "https://test.supabase.example", serviceRoleKey: "service-role-test" };
let accessCalls = 0;
function deps(access: FinanceAccess | "throw", store: typeof STORE | null = STORE): Deps {
  return {
    airtable: { baseId: "appQktredAuGa1X7e", token: "t" },
    registry: IMPLEMENTED_EVALUATORS,
    lock: fakeLock,
    financeAccess: async () => {
      accessCalls++;
      if (access === "throw") throw new Error("grant store down");
      return access;
    },
    ...(store ? { financeStore: store } : {}),
  };
}
async function run(access: FinanceAccess | "throw" = "manage", now = NOW, q: { view?: string; caseKey?: string; debug?: boolean } = { debug: true }, store: typeof STORE | null = STORE, caller = MANAGER) {
  accessCalls = 0;
  requests = [];
  sbRequests = [];
  const out = await getCases(deps(access, store), caller, q, now);
  if (out.status !== "ok") return out as any;
  return out.body as any;
}
const MO_KEYS = Object.values(MONEY_OUT_RULES).map((r) => r.ruleKey);
const mo = (b: any) => (b.cases ?? []).filter((c: any) => MO_KEYS.includes(c.ruleKey));
const caseOf = (b: any, i: Instalment) => mo(b).filter((c: any) => c.targetIds.instalmentId === i.instalmentId);
const empCase = (b: any, v: EmploymentVersion, month: string) => mo(b).filter((c: any) => c.targetIds.employmentId === v.employmentId && c.targetIds.month === month);
const ruleOf = (b: any, i: Instalment) => caseOf(b, i).map((c: any) => c.ruleKey).join();
const sbGets = (t: string) => sbRequests.filter((r) => r.method === "GET" && r.table === t).length;

async function main() {
  // ===== PD: payment due / overdue (brief 1-8) =====
  {
    db = STD();
    world();
    const b = await run();
    const today = caseOf(b, I_TODAY)[0];
    ck("PD1. Confirmed supplier instalment due today -> ATT-049 outgoing_payment_due_today (Warning, Review Outgoing Payment; source action Review Supplier Payment)", !!today && today.ruleKey === "outgoing_payment_due_today" && today.ruleId === "ATT-049" && today.severity === "Warning" && today.actionLabel === "Review Outgoing Payment" && today.context.sourceAction === "Review Supplier Payment" && today.context.remaining === "500.00" && today.context.dueDate === "2026-10-02", JSON.stringify(today));
    const over = caseOf(b, I_OVER)[0];
    ck("PD2. Confirmed instalment past due -> ATT-050 outgoing_payment_overdue: payee, remaining, due date, 7 days overdue, route to the real source", !!over && over.ruleKey === "outgoing_payment_overdue" && over.ruleId === "ATT-050" && over.context.payeeName === "ZZTEST F16 Venue" && over.context.remaining === "300.00" && over.context.daysOverdue === 7 && over.context.sourceType === "supplier_instalment" && over.destination?.route === "finance/supplier-instalment" && over.destination?.params?.instalmentId === I_OVER.instalmentId && over.context.sourceApi === `GET /finance/supplier-instalments/${I_OVER.instalmentId}`, JSON.stringify(over));
    ck("PD3. A future confirmed payment raises no case", caseOf(b, I_FUT).length === 0);
    ck("PD4. A paid (settled) instalment raises no case", caseOf(b, I_PAID).length === 0);
    ck("PD5. A cancelled instalment raises no case (and is not even read: cancelled_at=is.null)", caseOf(b, I_CANC).length === 0 && sbRequests.some((r) => r.table === "finance_supplier_instalments" && r.params.get("cancelled_at") === "is.null"));
    const part = caseOf(b, I_PART)[0];
    ck("PD6. Partially paid overdue instalment stays overdue for the OUTSTANDING balance only (300.00 of 500.00, cash paid 200.00)", !!part && part.ruleKey === "outgoing_payment_overdue" && part.context.remaining === "300.00" && part.context.amountDue === "500.00" && part.context.cashPaid === "200.00" && part.context.state === "partially_paid" && /£300\.00 still to pay \(of £500\.00\)/.test(part.detail), JSON.stringify(part));
    const cred = caseOf(b, I_CRED)[0];
    ck("PD7. Applied supplier credit already reduces the case amount (400.00 - 100.00 credit = 300.00; credit shown separately, never as cash)", !!cred && cred.context.remaining === "300.00" && cred.context.creditApplied === "100.00" && cred.context.cashPaid === "0.00" && /supplier credit applied £100\.00/.test(cred.detail) && remainingOf(I_CRED) === 30000);
    ck("PD8. Fully credit-settled (and cash + credit settled) instalments raise no case", caseOf(b, I_CREDFULL).length === 0 && caseOf(b, I_CASHCRED).length === 0);
    ck("PD9. Another organisation's overdue instalment never appears (organisation_id=eq.<profile organisation> on every Finance read)", caseOf(b, I_X).length === 0 && !mo(b).some((c: any) => c.context.payeeName === "Other Org Supplier") && sbRequests.length > 0 && sbRequests.every((r) => r.params.get("organisation_id") === `eq.${ORG_ID}`));
    ck("PD10. Severities follow the catalogue: payment due today / overdue Warning; nothing Urgent", mo(b).filter((c: any) => c.ruleKey.startsWith("outgoing_payment")).every((c: any) => c.severity === "Warning") && mo(b).every((c: any) => c.severity !== "Urgent"));
  }

  // ===== EM: employment months (brief 9-11) =====
  {
    db = STD();
    world();
    const b = await run();
    const e9 = empCase(b, V3, "2026-10")[0];
    ck("EM9. Confirmed employment cost due today -> ATT-049, source action Review Employment Cost, route finance/employment-cost", !!e9 && e9.ruleKey === "outgoing_payment_due_today" && e9.context.sourceType === "employment_cost" && e9.context.sourceAction === "Review Employment Cost" && e9.destination?.route === "finance/employment-cost" && e9.destination?.params?.month === "2026-10" && e9.context.remaining === "1000.00" && e9.context.itemId === IT3_OCT.itemId, JSON.stringify(e9));
    const e10 = empCase(b, V1, "2026-09")[0];
    ck("EM10. Confirmed employment cost not paid after its pay date -> ATT-050, 4 days overdue, the confirmed amount (2650.00, not the estimate)", !!e10 && e10.ruleKey === "outgoing_payment_overdue" && e10.context.daysOverdue === 4 && e10.context.remaining === "2650.00" && e10.title === "Payment overdue - ZZTEST F16 Salaried Coach - Sep 2026 employment cost", JSON.stringify(e10));
    ck("EM11. A paid employment month raises nothing", empCase(b, V1, "2026-08").length === 0);
    ck("EM11b. A future employment month outside the window raises nothing (E1 Oct, pay day 28)", empCase(b, V1, "2026-10").length === 0);
  }

  // ===== ES: estimates (brief 12-19) =====
  {
    db = STD();
    world();
    const b = await run();
    const soon = caseOf(b, E_SOON)[0];
    ck("ES12. Estimated cost due in 2 days (window 3) -> ATT-051 outgoing_estimate_due_soon, Normal, Confirm Cost", !!soon && soon.ruleKey === "outgoing_estimate_due_soon" && soon.severity === "Normal" && soon.actionLabel === "Confirm Cost" && soon.context.sourceAction === "Confirm Cost" && soon.context.daysUntilDue === 2 && soon.context.reminderDays === 3 && soon.context.reminderSource === "finance_baseline" && soon.title === "Estimated cost due in 2 days - ZZTEST F16 Contractor", JSON.stringify(soon));
    ck("ES13. Estimated cost due in 7 days (outside the window) -> no case", caseOf(b, E_FAR).length === 0);
    const tod = caseOf(b, E_TODAY)[0];
    ck("ES14. Still estimated on its due date -> ATT-052 'Amount still estimated' (Warning, Confirm Cost), not the approaching case", !!tod && tod.ruleKey === "outgoing_estimate_due_today" && tod.severity === "Warning" && tod.context.sourceAction === "Confirm Cost" && /^Amount still estimated - /.test(tod.title) && caseOf(b, E_TODAY).length === 1);
    const ov = caseOf(b, E_OVER)[0];
    ck("ES15. Still estimated after its due date -> ATT-053 'Estimate overdue' (Warning, Confirm Cost)", !!ov && ov.ruleKey === "outgoing_estimate_overdue" && ov.severity === "Warning" && ov.context.sourceAction === "Confirm Cost" && /^Estimate overdue - /.test(ov.title) && ov.context.daysOverdue === 2);
    ck("ES15b. Employment estimates too: E2 Sep (pay date 2 Sep) estimate overdue, E2 Oct (2 Oct) amount still estimated, E4 Oct (4 Oct) due soon", empCase(b, V2, "2026-09")[0]?.ruleKey === "outgoing_estimate_overdue" && empCase(b, V2, "2026-10")[0]?.ruleKey === "outgoing_estimate_due_today" && empCase(b, V4, "2026-10")[0]?.ruleKey === "outgoing_estimate_due_soon" && empCase(b, V4, "2026-10")[0]?.context.remaining === "1500.00");
    const pm = empCase(b, V5, "2026-09")[0];
    ck("ES15c. A part month (started 10 Sep) still raises its estimate case, flagged part month - the estimate is never silently pro-rated or dropped", !!pm && pm.ruleKey === "outgoing_estimate_overdue" && pm.context.partMonth === true && pm.context.remaining === "1000.00" && /part month/.test(pm.detail));
    // 16: walk ONE estimated source through soon -> today -> overdue: always exactly one estimate case, never a payment case.
    const seen: string[] = [];
    for (const day of ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-05"]) {
      const bb = await run("manage", new Date(`${day}T10:00:00.000Z`));
      const cs = caseOf(bb, E_TODAY);
      seen.push(`${day}:${cs.length}:${cs.map((c: any) => c.ruleKey).join()}`);
    }
    ck("ES16. One estimated source escalates soon -> today -> overdue and never has two cases (or a payment case) at once", seen.join(" ") === "2026-09-29:1:outgoing_estimate_due_soon 2026-09-30:1:outgoing_estimate_due_soon 2026-10-01:1:outgoing_estimate_due_soon 2026-10-02:1:outgoing_estimate_due_today 2026-10-03:1:outgoing_estimate_overdue 2026-10-05:1:outgoing_estimate_overdue", seen.join(" "));
    // 17: Management enters the actual amount on the overdue estimate.
    db.instalments.find((i) => i.instalmentId === E_OVER.instalmentId)!.amountState = "confirmed";
    db.instalments.find((i) => i.instalmentId === E_OVER.instalmentId)!.amountDueMinor = 12500;
    const b17 = await run();
    ck("ES17. Confirming the actual amount clears the estimate case; the confirmed, unpaid, past-due amount is now a payment-overdue case for 125.00", ruleOf(b17, E_OVER) === "outgoing_payment_overdue" && caseOf(b17, E_OVER)[0].context.remaining === "125.00" && caseOf(b17, E_OVER)[0].context.estimated === false);
    // 18: Use Estimate on the amount-still-estimated cost (due today).
    db.instalments.find((i) => i.instalmentId === E_TODAY.instalmentId)!.amountState = "confirmed";
    const b18 = await run();
    ck("ES18. Use Estimate clears the estimate case and, being due today, raises the payment-due-today case for the same amount", ruleOf(b18, E_TODAY) === "outgoing_payment_due_today" && caseOf(b18, E_TODAY)[0].context.remaining === "80.00");
    // 19: paid clears everything.
    for (const x of [E_OVER, E_TODAY, I_TODAY, I_OVER]) { const r = db.instalments.find((i) => i.instalmentId === x.instalmentId)!; r.paidMinor = r.amountDueMinor - r.creditedMinor; }
    db.items.find((i) => i.itemId === IT1_SEP.itemId)!.paidMinor = 265000;
    db.items.find((i) => i.itemId === IT1_SEP.itemId)!.paidAt = "2026-10-02T09:00:00.000Z";
    const b19 = await run();
    ck("ES19. Paid clears every case for those sources (supplier + employment)", [E_OVER, E_TODAY, I_TODAY, I_OVER].every((x) => caseOf(b19, x).length === 0) && empCase(b19, V1, "2026-09").length === 0);
    // Employment Use Estimate (E2 Oct, due today) -> payment due today.
    db = STD();
    db.items.push(item(7, V2, "2026-10", { due: "2026-10-02", amount: 200000 }));
    const b18e = await run();
    ck("ES18b. Employment Use Estimate on the due date: the estimate case goes, the payment-due-today case appears", empCase(b18e, V2, "2026-10").map((c: any) => c.ruleKey).join() === "outgoing_payment_due_today");
  }

  // ===== SET: F2 Estimate Reminder Days =====
  {
    ck("SET1. F2 setting estimateReminderDays: whole 0..60 or blank; stored as 'Estimate Reminder Days'; never part of completeness", FIELD_VALIDATORS.estimateReminderDays(0).ok && FIELD_VALIDATORS.estimateReminderDays(60).ok && FIELD_VALIDATORS.estimateReminderDays(null).ok && [-1, 61, 2.5, "3"].every((v) => !FIELD_VALIDATORS.estimateReminderDays(v).ok) && ESTIMATE_REMINDER_DAYS_MAX === 60 && SETTINGS_KEYS.includes("estimateReminderDays" as any) && !canon("finance/finance-settings.ts").slice(canon("finance/finance-settings.ts").indexOf("export function requiredKeys")).slice(0, 600).includes("estimateReminderDays"));
    ck("SET2. Blank = the Finance baseline (3 days, the Finance pack's default) - not organisation-specific code", DEFAULT_ESTIMATE_REMINDER_DAYS === 3 && estimateReminderDaysOf(null) === 3 && estimateReminderDaysOf({ estimateReminderDays: null }) === 3 && estimateReminderDaysOf({ estimateReminderDays: 0 }) === 0 && estimateReminderDaysOf({ estimateReminderDays: 7 }) === 7);
    const p = fromStoredRow(settingsRow(7) as any);
    ck("SET3. Stored round trip: 'Estimate Reminder Days' 7 reads back as 7", p.ok && p.state.settings.estimateReminderDays === 7);
    db = STD();
    world({ finSettings: [settingsRow(7)] });
    const b7 = await run();
    ck("SET4. Organisation setting 7 days: the 7-day-away estimate now raises the reminder (reminderSource organisation_setting)", ruleOf(b7, E_FAR) === "outgoing_estimate_due_soon" && caseOf(b7, E_FAR)[0].context.reminderDays === 7 && caseOf(b7, E_FAR)[0].context.reminderSource === "organisation_setting");
    world({ finSettings: [settingsRow(0)] });
    const b0 = await run();
    ck("SET5. Setting 0: no advance reminder at all, but due-today and overdue estimates still raise their cases", mo(b0).every((c: any) => c.ruleKey !== "outgoing_estimate_due_soon") && ruleOf(b0, E_TODAY) === "outgoing_estimate_due_today" && ruleOf(b0, E_OVER) === "outgoing_estimate_overdue");
    world({ finSettings: [settingsRow(7, ORG2)] });
    const bo = await run();
    ck("SET6. Another organisation's Finance Settings are never used (baseline 3 here)", caseOf(bo, E_FAR).length === 0 && caseOf(bo, E_SOON)[0]?.context.reminderSource === "finance_baseline");
    world({ finSettings: [settingsRow(7), { ...settingsRow(5), id: rid("FinSetDup2") }] });
    const bd = await run();
    ck("SET7. Two Finance Settings rows for the organisation -> loud, incomplete; Money Out not guessed", bd.complete === false && mo(bd).length === 0 && bd.configIssues.some((i: any) => i.code === "evaluator_error" && /More than one Finance Settings/.test(i.detail)));
  }

  // ===== AC: access (brief 20-26) =====
  {
    db = STD();
    world();
    const bm = await run("manage");
    ck("AC20. Finance Manage sees every Money Out case and may snooze them (exceptionAllowed)", mo(bm).length > 0 && mo(bm).every((c: any) => c.exceptionAllowed === true));
    const bv = await run("view");
    ck("AC21. Finance View sees the same cases", mo(bv).length === mo(bm).length && JSON.stringify(mo(bv).map((c: any) => c.caseKey).sort()) === JSON.stringify(mo(bm).map((c: any) => c.caseKey).sort()));
    ck("AC22a. Finance View cases are read-only (exceptionAllowed false)", mo(bv).every((c: any) => c.exceptionAllowed === false));
    const vk = mo(bv)[0].caseKey;
    const vEx = await createException(deps("view"), MANAGER, { caseKey: vk, reason: "remind me later" }, NOW);
    ck("AC22. Finance View cannot snooze: 403 finance_manage_required, nothing written", vEx.status === "rejected" && (vEx as any).httpStatus === 403 && (vEx as any).code === "finance_manage_required" && (tables[EXC] ?? []).length === 0);
    const bn = await run("none");
    ck("AC23. No Finance grant: no Money Out case, count, amount or payee - and no Finance source is read at all", mo(bn).length === 0 && sbRequests.length === 0 && !JSON.stringify(bn).includes("ZZTEST F16") && bn.diagnostics.skipped.filter((s: any) => MO_KEYS.includes(s.ruleKey)).every((s: any) => s.reason === "finance_access_required"));
    world({ financeOn: false });
    const boff = await run("manage");
    ck("AC24. module_finance OFF: no Money Out case, no grant lookup, no Finance read", mo(boff).length === 0 && sbRequests.length === 0 && accessCalls === 0);
    world();
    const coach = await run("manage", NOW, { debug: true }, STORE, { ...MANAGER, role: "coach" });
    const parent = await run("manage", NOW, { debug: true }, STORE, { ...MANAGER, role: "parent" });
    ck("AC25. Coach / Parent never reach the Management queue (403 management_only), no Finance read", coach.status === "rejected" && coach.httpStatus === 403 && parent.status === "rejected" && parent.httpStatus === 403 && sbRequests.length === 0);
    const bt = await run("throw");
    ck("AC26. Finance grant lookup fails -> fail closed: no Money Out case, no Finance read, complete:false + finance_access_unavailable", mo(bt).length === 0 && sbRequests.length === 0 && bt.complete === false && bt.configIssues.some((i: any) => i.code === "finance_access_unavailable"));
  }

  // ===== SN: snooze (brief 27-30) =====
  {
    db = STD();
    world();
    const before = JSON.stringify(db);
    const b = await run();
    const key = caseOf(b, I_OVER)[0].caseKey;
    const until = "2026-10-05T09:00:00.000Z";
    const ex = await createException(deps("manage"), MANAGER, { caseKey: key, reason: "Remind me in 3 days - paying on Monday", effectiveUntil: until }, NOW);
    const b2 = await run();
    const sup = b2.diagnostics.suppressedCases.find((s: any) => s.caseKey === key);
    ck("SN27. Finance Manage snoozes the exact case (3 days): only that case is hidden, every other Money Out case stays", ex.status === "ok" && caseOf(b2, I_OVER).length === 0 && !!sup && sup.effectiveUntil === until && mo(b2).length === mo(b).length - 1, JSON.stringify(ex));
    ck("SN28. Snooze does not alter the due date, amount or state: no Finance write of any kind, Finance rows identical", JSON.stringify(db) === before && sbRequests.every((r) => r.method === "GET") && requests.filter((r) => r.method !== "GET").every((r) => r.table === EXC));
    const b3 = await run("manage", new Date("2026-10-05T10:00:00.000Z"));
    ck("SN29. After the snooze ends the case is back, still overdue with the true, grown overdue count (10 days) - snooze never paused overdue", caseOf(b3, I_OVER)[0]?.ruleKey === "outgoing_payment_overdue" && caseOf(b3, I_OVER)[0]?.context.daysOverdue === 10 && caseOf(b3, I_OVER)[0]?.context.dueDate === "2026-09-25");
    db.instalments.find((i) => i.instalmentId === I_OVER.instalmentId)!.paidMinor = 30000;
    const b4 = await run();
    ck("SN30. Source resolved (paid at source): the case disappears naturally - neither active nor suppressed, no 'mark complete' anywhere", caseOf(b4, I_OVER).length === 0 && !b4.diagnostics.suppressedCases.some((s: any) => s.caseKey === key) && !/mark[_ -]?complete|markComplete|"complete":\s*true/i.test(canon("needs-attention/money-out.ts").replace(/\/\*[\s\S]*?\*\//g, "")));
  }

  // ===== ID: identity + no duplicates (brief 31-34) =====
  {
    db = STD();
    world();
    const b = await run();
    const keys = mo(b).map((c: any) => c.caseKey);
    ck("ID31. Stable keys: <rule>|supplier_instalment:<FSI-> and <rule>|employment_cost:<FEM->|month:<YYYY-MM> (no name, amount or date)", caseOf(b, I_OVER)[0].caseKey === `outgoing_payment_overdue|supplier_instalment:${I_OVER.instalmentId}` && empCase(b, V1, "2026-09")[0].caseKey === `outgoing_payment_overdue|employment_cost:${V1.employmentId}|month:2026-09` && keys.every((k: string) => !/ZZTEST|£|\d+\.\d\d|2026-\d\d-\d\d/.test(k)));
    const moved = caseOf(b, I_MOVED)[0];
    const k1 = caseOf(b, I_OVER)[0].caseKey;
    db.instalments.find((i) => i.instalmentId === I_OVER.instalmentId)!.dueDate = "2026-09-27";
    const b2 = await run();
    ck("ID32. Moving a due date keeps the SAME case (same key, new overdue count) - never a duplicate; a moved-earlier instalment shows the move", caseOf(b2, I_OVER).length === 1 && caseOf(b2, I_OVER)[0].caseKey === k1 && caseOf(b2, I_OVER)[0].context.daysOverdue === 5 && moved.context.dueDateMoved === true && moved.context.originalDueDate === "2026-10-20" && moved.context.daysOverdue === 3);
    db.instalments.find((i) => i.instalmentId === I_OVER.instalmentId)!.dueDate = "2026-10-10";
    const b3 = await run();
    ck("ID32b. Moving it into the future: no case at all (not 'snoozed', simply not due)", caseOf(b3, I_OVER).length === 0);
    db = STD();
    const all: string[] = [];
    let maxPerSource = 0;
    for (const day of ["2026-09-01", "2026-09-25", "2026-09-30", "2026-10-02", "2026-10-03", "2026-10-15"]) {
      const bb = await run("manage", new Date(`${day}T10:00:00.000Z`));
      const ks = mo(bb).map((c: any) => c.caseKey);
      all.push(...ks);
      const perSource = new Map<string, number>();
      for (const c of mo(bb)) { const s = c.caseKey.slice(c.caseKey.indexOf("|")); perSource.set(s, (perSource.get(s) ?? 0) + 1); }
      maxPerSource = Math.max(maxPerSource, ...perSource.values(), 0);
      if (new Set(ks).size !== ks.length) maxPerSource = 99;
    }
    ck("ID33. Never both due-today and overdue for one source (any day)", maxPerSource === 1);
    ck("ID34. Never two estimate cases for one source, never an estimate + a payment case (at most ONE case per source per day)", maxPerSource === 1 && all.length > 0);
    ck("ID34b. bucketOf is exclusive: estimated -> estimate rules only; confirmed / partially paid -> payment rules only; paid / cancelled / 0 remaining -> none", bucketOf("estimated", 100, "2026-10-01", "2026-10-02", 3)?.bucket === "estimate_overdue" && bucketOf("confirmed", 100, "2026-10-01", "2026-10-02", 3)?.bucket === "payment_overdue" && bucketOf("confirmed", 100, "2026-10-04", "2026-10-02", 3) === null && bucketOf("partially_paid", 100, "2026-10-02", "2026-10-02", 3)?.bucket === "payment_due_today" && bucketOf("paid", 0, "2026-10-01", "2026-10-02", 3) === null && bucketOf("cancelled", 100, "2026-10-01", "2026-10-02", 3) === null && bucketOf("confirmed", 0, "2026-10-01", "2026-10-02", 3) === null);
  }

  // ===== DT: organisation-local dates (brief 35-36) =====
  {
    db = STD();
    world();
    const late = await run("manage", new Date("2026-10-01T23:30:00.000Z")); // 00:30 BST on 2 Oct; UTC still says 1 Oct
    ck("DT35. Organisation-local today: at 23:30 UTC on 1 Oct it is already 2 Oct in London -> the 2 Oct payment is DUE TODAY (UTC would say not yet)", ruleOf(late, I_TODAY) === "outgoing_payment_due_today");
    const eod = await run("manage", new Date("2026-10-02T22:59:00.000Z"));
    const next = await run("manage", new Date("2026-10-02T23:00:00.000Z"));
    ck("DT35b. 23:59 BST on 2 Oct is still due today; 00:00 BST on 3 Oct it is overdue by exactly 1 calendar day", ruleOf(eod, I_TODAY) === "outgoing_payment_due_today" && ruleOf(next, I_TODAY) === "outgoing_payment_overdue" && caseOf(next, I_TODAY)[0].context.daysOverdue === 1);
    world({ tz: "Pacific/Auckland" });
    const nz = await run("manage", new Date("2026-10-01T12:00:00.000Z")); // 01:00 NZDT on 2 Oct
    ck("DT35c. The organisation's own time zone is used (Pacific/Auckland: 12:00 UTC 1 Oct is already 2 Oct)", ruleOf(nz, I_TODAY) === "outgoing_payment_due_today");
    world();
    const b = await run();
    ck("DT36. Overdue days are whole calendar days in the organisation's zone (25 Sep -> 2 Oct = 7; 20 Sep -> 12; 28 Sep pay date -> 4)", caseOf(b, I_OVER)[0].context.daysOverdue === 7 && caseOf(b, I_PART)[0].context.daysOverdue === 12 && empCase(b, V1, "2026-09")[0].context.daysOverdue === 4 && /7 days overdue/.test(caseOf(b, I_OVER)[0].detail));
    ck("DT36b. Anchors: the due date's local midnight (BST) and 'outstanding since' the next local midnight", caseOf(b, I_OVER)[0].anchorTime === "2026-09-24T23:00:00.000Z");
  }

  // ===== PF: bounded reads =====
  {
    db = STD();
    // 200 suppliers' worth of instalments + 30 employees
    for (let k = 0; k < 200; k++) db.instalments.push(inst({ due: k % 2 ? "2026-09-15" : "2026-11-15", amount: 1000 + k }));
    for (let k = 0; k < 30; k++) db.versions.push(ver(200 + k, { emp: 200 + k, name: `ZZTEST F16 Person ${k}`, annual: 1200000, payDay: 28, start: "2026-01-01", from: "2026-01" }));
    world();
    const r0 = moneyOutPassStats().runs;
    const b = await run();
    const perTable = ["finance_suppliers", "finance_supplier_instalments", "finance_employment_versions", "finance_employment_items"].map(sbGets);
    ck("PF1. All five rules share ONE pass and each Finance table is read exactly once (one page each), no per-source read, no Finance API call", moneyOutPassStats().runs === r0 + 1 && perTable.every((n) => n === 1) && sbRequests.length === 4 && b.diagnostics.evaluated.filter((e: any) => MO_KEYS.includes(e.ruleKey)).length === 5, JSON.stringify(perTable));
    ck("PF2. 100 overdue instalments + 30 employees x 9 months -> cases from that single pass (270 estimate-overdue employee months)", caseOf(b, I_OVER).length === 1 && mo(b).filter((c: any) => c.ruleKey === "outgoing_payment_overdue").length >= 100 && mo(b).filter((c: any) => /Person/.test(c.context.payeeName)).length === 30 * 9);
    ck("PF3. Airtable: Finance Settings listed once; config tables once each", requests.filter((r) => r.table === SETTINGS_TABLE).length === 1 && Object.values(CONFIG_TABLES).every((t) => requests.filter((r) => r.table === t).length === 1));
    world();
    sbBig = 2500;
    await run();
    const pages = sbRequests.filter((r) => r.table === "finance_supplier_instalments").map((r) => `${r.params.get("offset")}/${r.params.get("limit")}`);
    ck("PF4. Paged reads (1000 rows a page, stable primary-key order): 2500 rows -> 3 pages", pages.join() === "0/1000,1000/1000,2000/1000" && FINANCE_PAGE_SIZE === 1000 && sbRequests.find((r) => r.table === "finance_supplier_instalments")!.params.get("order") === "instalment_id.asc");
    world({ settings: [...F16_RULES.map((r) => enable(r)), enable(RULE_OVERDUE)] });
    sbBig = FINANCE_PAGE_SIZE * FINANCE_MAX_PAGES + 1;
    const big = await run();
    ck("PF5. An unbounded table is refused loudly (more than 20 pages): every Money Out rule incomplete, ATT-047 unaffected", big.complete === false && mo(big).length === 0 && big.configIssues.filter((i: any) => i.code === "evaluator_error" && MO_KEYS.includes(i.ruleKey) && /refusing an unbounded read/.test(i.detail)).length === 5 && big.diagnostics.evaluated.some((e: any) => e.ruleKey === "invoice_overdue"));
  }

  // ===== DQ: data quality / availability =====
  {
    db = STD();
    world();
    sbFail = { finance_employment_items: 500 };
    const b = await run();
    ck("DQ1. A Finance table that cannot be read -> those rules are reported incomplete (evaluator_error), never 'no cases'", b.complete === false && mo(b).length === 0 && b.configIssues.filter((i: any) => i.code === "evaluator_error" && MO_KEYS.includes(i.ruleKey) && /finance_employment_items/.test(i.detail)).length === 5);
    world();
    const ns = await run("manage", NOW, { debug: true }, null);
    ck("DQ2. No Finance store configured -> incomplete with a reason, not an empty queue", ns.complete === false && mo(ns).length === 0 && ns.configIssues.some((i: any) => /Finance store not configured/.test(i.detail)));
    world();
    sbLeakForeign = true;
    const lk = await run();
    ck("DQ3. A Finance read that returns another organisation's row is refused (loud), never shown", lk.complete === false && mo(lk).length === 0 && !JSON.stringify(lk.cases ?? []).includes("Other Org"));
    db = STD();
    world();
    db.instalments.push({ ...inst({ due: "2026-09-01", amount: 100 }), supplierId: "FSU-00000000BEEF" });
    const orphan = await run();
    ck("DQ4. An instalment whose supplier does not exist -> loud data error, no guess", orphan.complete === false && orphan.configIssues.some((i: any) => i.code === "evaluator_error" && /invalid id \/ agreement \/ supplier/.test(i.detail)));
    db = STD();
    world();
    db.instalments.find((i) => i.instalmentId === I_PART.instalmentId)!.paidMinor = 60000;
    const over = await run();
    ck("DQ5. An instalment with more paid than due -> loud data error", over.complete === false && over.configIssues.some((i: any) => /paid \/ credited more than is due/.test(i.detail)));
    db = STD();
    world();
    const ctx = { now: NOW, organisation: { recordId: ORG, organisationId: ORG_ID, name: "Test Org", timezone: TZ }, sources: Object.freeze({ [MONEY_OUT_TABLES.suppliers]: dbRows("finance_suppliers").filter((r) => r.organisation_id === ORG_ID), [MONEY_OUT_TABLES.instalments]: dbRows("finance_supplier_instalments").filter((r) => r.organisation_id === ORG_ID), [MONEY_OUT_TABLES.versions]: [], [MONEY_OUT_TABLES.items]: [], [SETTINGS_TABLE]: [] }) } as any;
    const pass = runMoneyOutPass(ctx);
    ck("DQ6. A cancelled instalment that reaches the pass anyway still raises nothing", !pass.items.some((i) => i.instalmentId === I_CANC.instalmentId));
    let foreign = "";
    try {
      runMoneyOutPass({ ...ctx, now: new Date(NOW.getTime() + 1), sources: Object.freeze({ ...ctx.sources, [MONEY_OUT_TABLES.instalments]: dbRows("finance_supplier_instalments") }) });
    } catch (e) {
      foreign = e instanceof Error ? e.message : String(e);
    }
    ck("DQ7. Defence in depth: a foreign-organisation row reaching the pass directly (loader bypassed) is refused, never shown", /a row of another organisation was returned/.test(foreign), foreign);
  }

  // ===== DR: drift / scope =====
  {
    const mine = canon("needs-attention/money-out.ts");
    const blocks = [...mine.matchAll(/\/\/ ===== COPIED FROM (finance\/[a-z-]+\.ts) - DO NOT EDIT HERE =====\n([\s\S]*?)\/\/ ===== END COPIED BLOCK =====/g)];
    const verify = blocks.map((m) => ({ file: m[1], missing: m[2].split("\n").filter((l) => l.trim() && !canon(m[1]).includes(l)) }));
    ck("DR1. Copied row readers (F13 supplier / instalment, F15 version / item) appear verbatim in their Finance repositories", blocks.length === 4 && verify.every((v) => v.missing.length === 0), JSON.stringify(verify.filter((v) => v.missing.length)));
    const code = mine.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    ck("DR2. Remaining payable and state are F13's own remainingOf / stateOf (imported); no balance is computed here", /remainingOf\(i\)/.test(code) && /stateOf\(i\)/.test(code) && /stateOf\(inst\)/.test(code) && !/amountDueMinor\s*-/.test(code) && /from "\.\.\/finance\/finance-suppliers\.ts"/.test(mine) && /monthLine\(chain, empItems, month\)/.test(code));
    ck("DR3. Read-only: no fetch / write in the evaluator; the Finance loader only ever GETs allowlisted tables", !/\bfetch\(|method:\s*["'`](POST|PATCH|PUT|DELETE)|Deno\./.test(code) && Object.keys(FINANCE_SOURCES).sort().join() === MONEY_OUT_SOURCES.filter((s) => s.startsWith("supabase:")).sort().join() && !/method:/.test(canon("needs-attention/repository.ts").slice(canon("needs-attention/repository.ts").indexOf("export async function loadFinanceSource"))));
    const f13 = canon("finance/finance-suppliers-repository.ts"), f15 = canon("finance/finance-overheads-repository.ts");
    ck("DR4. Every Finance source table is a real F13 / F15 table name (from their repositories)", Object.values(FINANCE_SOURCES).every((s) => f13.includes(`"${s.table}"`) || f15.includes(`"${s.table}"`)));
    const fixture = JSON.parse(readFileSync(join(HERE, "needs-attention-catalogue.fixture.json"), "utf8")).rules as any[];
    const reg = IMPLEMENTED_EVALUATORS.filter((e) => /^ATT-0(49|5[0-3])$/.test(e.ruleId));
    ck("DR5. Registered exactly the five F16 rules with the catalogue's IDs / keys (module_finance, Default Enabled off)", reg.length === 5 && reg.every((e) => fixture.some((f) => f.ruleId === e.ruleId && f.ruleKey === e.ruleKey && f.requiredModule === "module_finance" && f.defaultEnabled === false)) && reg.every((e) => e.sources === MONEY_OUT_SOURCES));
    ck("DR6. F12 Coach Months are NOT a source (no Paid fact in F12): no coach table, no coach-cost read", !MONEY_OUT_SOURCES.some((s) => /coach/i.test(s)) && !/coach_month|Finance Coach Month|coach-costs|COACH_COST/i.test(code));
    const script = readFileSync(join(HERE, "..", "..", "scripts", "build-needs-attention-bundle.mjs"), "utf8");
    const allow = [...script.slice(script.indexOf("SHARED_FINANCE_FILES = ["), script.indexOf("];", script.indexOf("SHARED_FINANCE_FILES = ["))).matchAll(/"([a-z-]+\.ts)"/g)].map((m) => m[1]);
    const imports = [...mine.matchAll(/from "\.\.\/finance\/([a-z-]+\.ts)"/g)].map((m) => m[1]);
    ck("DR7. money-out.ts imports only allowlisted pure Finance modules (bundled at build time; F13 / F15 pure modules added)", imports.every((f) => allow.includes(f)) && allow.includes("finance-suppliers.ts") && allow.includes("finance-overheads.ts") && allow.every((f) => !/orchestrator|repository|index/.test(f)) && ["finance-suppliers.ts", "finance-overheads.ts"].every((f) => !/\bfetch\(|Deno\.|createClient/.test(canon(`finance/${f}`).replace(/\/\*[\s\S]*?\*\//g, ""))));
    ck("DR8. No Cash Flow / Month Report / payroll / stored case / mark-complete code in F16", !/cash ?flow|cashflow|month ?report|payroll|payslip|insert|upsert/i.test(code));
    const mirror = readFileSync(join(HERE, "needs-attention-money-out.ts"), "utf8");
    ck("DR9. Test copy = canonical (import paths only)", mirror.endsWith(mine.replace(/from "\.\/needs-attention\.ts"/g, 'from "./needs-attention-engine.ts"').replace(/from "\.\/finance\.ts"/g, 'from "./needs-attention-finance.ts"').replace(/from "\.\/work-summaries\.ts"/g, 'from "./needs-attention-work-summaries.ts"').replace(/from "\.\/repository\.ts"/g, 'from "./needs-attention-repository.ts"').replace(/from "\.\.\/finance\/([a-z-]+\.ts)"/g, 'from "./$1"')));
  }

  for (const [s, n, e] of R) console.log(`${s}  ${n}${e && s === "FAIL" ? "  " + e : ""}`);
  const pass = R.filter((r) => r[0] === "PASS").length;
  console.log(`\nneeds-attention-money-out: ${pass}/${R.length} checks passed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
