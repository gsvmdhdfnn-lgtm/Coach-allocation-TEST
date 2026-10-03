/**
 * In-memory world for the Finance F17 (Cash Position / Cash Flow) suite.
 * Extends the shared F13 / F14 / F15 world (finance-overheads-world.ts) with:
 *   - finance_bank_balances + a fake finance_bank_balance_record database
 *     function with the same rules, CHECKs and append-only guard as the TEST
 *     SQL (finance_f17_cash_flow);
 *   - the F12 Finance Coach Month tables (read only here);
 *   - Airtable: Finance Settings, the F7 receivable tables (rows produced by
 *     F6 / F7's OWN create-field builders), and the F12 coach-cost tables.
 * The REAL F17 orchestrator, the F2 / F7 / F12 / F13 / F15 repositories and
 * the F13 / F14 / F15 orchestrators (for fixtures) run against it.
 */
import { isTenantKey } from "./finance-access.ts";
import { CHECK, MGR, ORG, ORG_REC, T_, audit, deps as supplierDeps, err, json, mgr, tick, world } from "./finance-overheads-world.ts";
import { reset as resetOverheads } from "./finance-overheads-world.ts";
import { EMPTY_SETTINGS, SETTINGS_KEYS, toStoredFields } from "./finance-settings.ts";
import type { CreditNote, Invoice } from "./finance-issue.ts";
import { creditNoteCreateFields, invoiceCreateFields } from "./finance-issue-mapping.ts";
import { applicationCreateFields, clientCreditCreateFields, dueChangeCreateFields, paymentCreateFields, paymentReversalCreateFields } from "./finance-receivables-mapping.ts";
import { type CashFlowDeps, readBalanceHistory, readCashFlow, recordBankBalance } from "./finance-cash-flow-orchestrator.ts";
import { parseBalance, parseCashQuery } from "./finance-cash-flow.ts";

export * from "./finance-overheads-world.ts";

export const CF_TABLES = ["finance_bank_balances", "finance_worker_cost_months", "finance_worker_cost_items", "finance_worker_cost_corrections"];
export const COACH_F17 = "recCOACHF17PAID01";
export const SESS_COACH = "recSessCoachF1700";
const hex = (n: number) => n.toString(16).toUpperCase().padStart(12, "0");
export const T0 = "2026-09-30T12:00:00.000Z";

// ----- F7 fixtures, built exactly as F6 / F7 store them -----
export const CLIENT = "FCL-AAAAAAAAAAAA";
let invSeq = 1000;
export function invoice(n: number, o: { gross: number; dueDate?: string | null; xero?: boolean; status?: Invoice["status"]; clientName?: string }): Invoice {
  const xero = !!o.xero;
  const s = ++invSeq;
  return {
    invoiceId: `FIV-${hex(n)}`,
    sourceDraftId: `FID-${hex(n)}`,
    clientId: CLIENT,
    clientName: o.clientName ?? "ZZTEST F17 School",
    billingContactName: null,
    billingEmail: "billing@school.test",
    billingCcEmails: [],
    invoiceDate: xero ? null : "2026-09-30",
    dueDate: xero ? null : o.dueDate ?? "2026-10-30",
    periodFrom: "2026-09-01",
    periodTo: "2026-09-30",
    paymentTermsDays: 30,
    paymentTermsSource: "client",
    poRequired: false,
    poNumber: null,
    poOverrideReason: null,
    netMinor: o.gross,
    vatMinor: 0,
    grossMinor: o.gross,
    currency: "GBP",
    lineCount: 1,
    status: o.status ?? (xero ? "awaiting_external_issue" : "issued"),
    issueAuthority: xero ? "external_accounting" : "hub",
    numberAuthority: xero ? "xero" : "hub",
    hubInvoiceNumber: xero ? null : `TEST-INV-${s}`,
    hubInvoiceSequence: xero ? null : s,
    externalProvider: null,
    externalInvoiceId: null,
    externalInvoiceNumber: null,
    replacesInvoiceId: null,
    correctionId: null,
    approvedOmissions: [],
    reviewSnapshot: "{}",
    issuer: { organisationId: ORG, organisationName: "Test Org", legalName: "Test Org Ltd", address: "1 Test Street", companyNumber: null, vatRegistered: false, vatNumber: null },
    frozenBy: MGR,
    frozenAt: T0,
    issuedBy: xero ? null : MGR,
    issuedAt: xero ? null : T0,
    revision: 1,
    updatedBy: MGR,
    updatedAt: T0,
  } as Invoice;
}
export function creditNote(n: number, inv: Invoice, gross: number, creditDate = "2026-10-09"): CreditNote {
  return {
    creditNoteId: `FCN-${hex(n)}`,
    invoiceId: inv.invoiceId,
    clientId: inv.clientId,
    clientName: inv.clientName,
    creditDate,
    reason: "ZZTEST correction",
    lines: [{ invoiceLineId: `FVL-${hex(n)}`, occurrenceId: `recOcc${n}:2026-09-10`, netMinor: gross, vatMinor: 0, grossMinor: gross }],
    netMinor: gross,
    vatMinor: 0,
    grossMinor: gross,
    currency: "GBP",
    status: "issued",
    issueAuthority: "hub",
    externalProvider: null,
    externalCreditNoteId: null,
    externalCreditNoteNumber: null,
    createdBy: MGR,
    createdAt: `${creditDate}T09:00:00.000Z`,
  } as CreditNote;
}
export const payment = (n: number, inv: Invoice, amountMinor: number, receivedDate: string) => ({
  paymentId: `FPY-${hex(n)}`, invoiceId: inv.invoiceId, clientId: inv.clientId, clientName: inv.clientName, amountMinor, currency: "GBP" as const, receivedDate,
  method: "bank_transfer" as const, reference: null, source: "manual" as const, externalProvider: null, externalPaymentId: null, reason: null, recordedBy: MGR, recordedAt: `${receivedDate}T12:00:00.000Z`,
});
export const paymentReversal = (n: number, p: ReturnType<typeof payment>) => ({ reversalId: `FPR-${hex(n)}`, paymentId: p.paymentId, invoiceId: p.invoiceId, clientId: p.clientId, amountMinor: p.amountMinor, reason: "entered by mistake", recordedBy: MGR, recordedAt: "2026-10-14T12:00:00.000Z" });
export const noteCredit = (n: number, o: { sourceInvoiceId: string; sourceCreditNoteId: string; original: number; remaining: number }) => ({
  creditId: `FCC-${hex(n)}`, clientId: CLIENT, clientName: "ZZTEST F17 School", source: "credit_note" as const, sourceInvoiceId: o.sourceInvoiceId, sourceCreditNoteId: o.sourceCreditNoteId, sourcePaymentId: null, receivedDate: null,
  originalMinor: o.original, remainingMinor: o.remaining, currency: "GBP" as const, status: (o.remaining === 0 ? "used" : "available") as "used" | "available", reason: "kept", voidReason: null, voidedBy: null, voidedAt: null,
  createdBy: MGR, createdAt: "2026-10-09T10:00:00.000Z", revision: 2, updatedBy: MGR, updatedAt: "2026-10-09T10:00:00.000Z",
});
export const overpaymentCredit = (n: number, o: { sourceInvoiceId: string; sourcePaymentId: string; original: number; receivedDate: string }) => ({
  creditId: `FCC-${hex(n)}`, clientId: CLIENT, clientName: "ZZTEST F17 School", source: "overpayment" as const, sourceInvoiceId: o.sourceInvoiceId, sourceCreditNoteId: null, sourcePaymentId: o.sourcePaymentId, receivedDate: o.receivedDate,
  originalMinor: o.original, remainingMinor: o.original, currency: "GBP" as const, status: "available" as const, reason: "kept the extra", voidReason: null, voidedBy: null, voidedAt: null,
  createdBy: MGR, createdAt: `${o.receivedDate}T12:30:00.000Z`, revision: 1, updatedBy: MGR, updatedAt: `${o.receivedDate}T12:30:00.000Z`,
});
export const application = (n: number, creditId: string, inv: Invoice, amountMinor: number) => ({ applicationId: `FCA-${hex(n)}`, creditId, invoiceId: inv.invoiceId, clientId: inv.clientId, amountMinor, reason: null, recordedBy: MGR, recordedAt: "2026-10-09T11:00:00.000Z" });
export const dueChange = (n: number, inv: Invoice, previousDueDate: string, newDueDate: string) => ({ changeId: `FDD-${hex(n)}`, invoiceId: inv.invoiceId, previousDueDate, newDueDate, reason: "agreed extension", changedBy: MGR, changedAt: "2026-10-14T09:00:00.000Z" });

export interface F7World {
  invoices: Invoice[];
  notes?: CreditNote[];
  payments?: ReturnType<typeof payment>[];
  reversals?: ReturnType<typeof paymentReversal>[];
  credits?: any[];
  applications?: ReturnType<typeof application>[];
  dueChanges?: ReturnType<typeof dueChange>[];
}
let rowN = 0;
const row = (fields: Record<string, unknown>) => ({ id: `recF7${String(++rowN).padStart(11, "0")}`, fields });
export function setF7(w: F7World) {
  world.at["Finance Invoices"] = w.invoices.map((i) => row(invoiceCreateFields(i, ORG_REC)));
  world.at["Finance Credit Notes"] = (w.notes ?? []).map((n) => row(creditNoteCreateFields(n, ORG_REC)));
  world.at["Finance Payments"] = [...(w.payments ?? []).map((p) => row(paymentCreateFields(p as any, ORG_REC))), ...(w.reversals ?? []).map((r) => row(paymentReversalCreateFields(r as any, ORG_REC)))];
  world.at["Finance Client Credits"] = (w.credits ?? []).map((c) => row(clientCreditCreateFields(c as any, ORG_REC)));
  world.at["Finance Client Credit Applications"] = (w.applications ?? []).map((a) => row(applicationCreateFields(a as any, ORG_REC)));
  world.at["Finance Invoice Due Date Changes"] = (w.dueChanges ?? []).map((d) => row(dueChangeCreateFields(d as any, ORG_REC)));
}

// ----- F2 Finance Settings (one row for the organisation) -----
export function setSettings(o: { thresholdMinor?: number | null; paymentDay?: number | null }) {
  const s = { ...EMPTY_SETTINGS, cashSafetyThresholdMinor: o.thresholdMinor ?? null, coachPaymentDayOfFollowingMonth: o.paymentDay ?? null };
  world.at["Finance Settings"] = [
    {
      id: "recFinSettings001",
      fields: Object.fromEntries(Object.entries({ "Finance Settings ID": `FINSET-${ORG}`, Organisation: [ORG_REC], ...toStoredFields(s, SETTINGS_KEYS), Revision: 1 }).filter(([, v]) => v !== null && v !== undefined)),
    },
  ];
}

// ----- F12 coach work (Airtable) + Finance Coach Months (Supabase) -----
export function coachOcc(key: string, date: string, status: string, allocationIds: string[]) {
  return { id: `rec${key.padEnd(14, "0").slice(0, 14)}`, fields: { "Occurrence ID": `OCC-${key}:${date}`, Date: date, Status: status, Session: [SESS_COACH], "Coach Allocations": allocationIds } };
}
export function allocation(key: string, occId: string, finalPounds: number | null, o: { coach?: string; basis?: string } = {}) {
  return {
    id: `rec${key.padEnd(14, "0").slice(0, 14)}`,
    fields: {
      "Allocation ID": `ALLOC-${key}`,
      "Session Occurrence": [occId],
      Coach: [o.coach ?? COACH_F17],
      "Rate Profile": ["recRateProfile001"],
      "Rate Type Snapshot": "Per Session",
      "Pay Unit Snapshot": "Session",
      "Paid Units": 1,
      "Rate Amount Snapshot": 45,
      ...(finalPounds === null ? {} : { "Final Coach Cost": finalPounds }),
      "Cost Status": "Confirmed",
      ...(o.basis ? { "Cost Basis": o.basis } : {}),
    },
  };
}
export function financeMonthRow(n: number, o: { workMonth: string; totalMinor: number; payDate: string; coach?: string; ref?: string; name?: string; items?: number }) {
  return {
    organisation_id: ORG,
    month_id: `FCM-${hex(n)}`,
    worker_record_id: o.coach ?? COACH_F17,
    worker_ref: o.ref ?? "COACH-F17",
    worker_name: o.name ?? "ZZTEST F17 Coach",
    work_month: `${o.workMonth}-01`,
    finalised_total_minor: o.totalMinor,
    item_count: o.items ?? 4,
    payment_day: Number(o.payDate.slice(8, 10)),
    expected_payment_date: o.payDate,
    snapshot_hash: "0".repeat(64),
    finalised_at: "2026-10-03T09:00:00.000Z",
    finalised_by: MGR,
    reason: null,
  };
}
export function correctionRow(n: number, monthId: string, amountMinor: number, resultingTotalMinor: number) {
  return { organisation_id: ORG, correction_id: `FCX-${hex(n)}`, month_id: monthId, amount_minor: amountMinor, allocation_record_id: null, reason: "ZZTEST late mileage", resulting_total_minor: resultingTotalMinor, created_at: "2026-10-04T09:00:00.000Z", created_by: MGR };
}

export function reset() {
  resetOverheads();
  for (const t of CF_TABLES) world.sb[t] = [];
  world.at["Coaches"] = [...(world.at["Coaches"] ?? []), { id: COACH_F17, fields: { "Coach ID": "COACH-F17", "Coach Name": "ZZTEST F17 Coach", Active: true } }];
  world.at["Sessions"] = [...(world.at["Sessions"] ?? []), { id: SESS_COACH, fields: { "Session ID": "ZZ-COACH-F17", "Session Name": "ZZTEST F17 Coached Session", Programme: "Academy", "Finance Service ID": "FSV-AAAAAAAAAAAA" } }];
  world.at["Coach Allocations"] = [];
  world.at["Work Summary Lines"] = [];
  world.at["Coach Work Summaries"] = [];
  setF7({ invoices: [] });
  world.at["Finance Settings"] = [];
  // F21 (information only in Cash Flow): F11 decisions with a card part + their Stripe refund executions.
  world.sb.finance_refund_decisions = [];
  world.sb.finance_stripe_refund_executions = [];
}

// ----- fake finance_bank_balance_record (same rules as finance_f17_cash_flow) -----
export class Refused17 extends Error {}
const no17: (code: string) => never = (code) => {
  throw new Refused17(`f17:${code}`);
};
export function checkBalance(b: any) {
  CHECK(/^FBB-[0-9A-F]{12}$/.test(b.balance_id) && Number.isSafeInteger(b.sequence) && b.sequence >= 1, "finance_bank_balances id/sequence");
  CHECK(Number.isSafeInteger(b.amount_minor) && Math.abs(b.amount_minor) <= 100_000_000_000, "finance_bank_balances amount");
  CHECK(/^\d{4}-\d{2}-\d{2}$/.test(b.as_at_date), "finance_bank_balances as_at_date");
  CHECK(b.note === null || (typeof b.note === "string" && b.note.trim().length >= 1 && b.note.length <= 500), "finance_bank_balances note");
}
export function balanceRpc(a: any): unknown {
  const b = a.p_balance;
  if (!Array.isArray(a.p_events) || !a.p_events.length) no17("audit_missing");
  const rows = T_("finance_bank_balances").filter((x) => x.organisation_id === b.organisation_id);
  const max = rows.reduce((m, x) => Math.max(m, x.sequence), 0);
  if (max !== a.p_expected_sequence || b.sequence !== max + 1) no17("balance_changed");
  checkBalance(b);
  // CHECK (as_at_date <= recorded_at UTC date + 1): the organisation's today is never later than that
  CHECK(b.as_at_date <= new Date(Date.parse(`${b.recorded_at.slice(0, 10)}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10), "finance_bank_balances as_at_date");
  if (T_("finance_bank_balances").some((x) => x.organisation_id === b.organisation_id && (x.balance_id === b.balance_id || x.sequence === b.sequence))) throw new Error('duplicate key value violates unique constraint "finance_bank_balances_sequence"');
  T_("finance_bank_balances").push({ ...b });
  audit(a.p_events);
  return { balance_id: b.balance_id, sequence: b.sequence };
}
/** Guard trigger: history is append-only (UPDATE / DELETE refused like the SQL guard). */
export const directBalanceWrite = (): { ok: false; message: string } => ({ ok: false, message: "f17:history_is_append_only" });

export const cfFetchLog: string[] = [];
export const cfFake = { balanceRpcFail: false, staleExpected: false };
const base = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(input);
  const method = (init.method || "GET").toUpperCase();
  cfFetchLog.push(`${method} ${decodeURIComponent(url.replace(/\?.*$/, ""))}`);
  if (/\/rpc\/finance_bank_balance_record$/.test(url)) {
    await tick();
    world.rpcCalls++;
    if (cfFake.balanceRpcFail) return json({ message: "boom" }, 500);
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (cfFake.staleExpected) body.p_expected_sequence = body.p_expected_sequence - 1;
    const snap = JSON.stringify({ sb: world.sb, audit: world.audit });
    try {
      return json(balanceRpc(body));
    } catch (e) {
      const s = JSON.parse(snap);
      world.sb = s.sb;
      world.audit = s.audit;
      if (e instanceof Refused17) return json({ code: "P0001", message: (e as Error).message }, 400);
      return json({ message: String(e) }, 409);
    }
  }
  if (/\/rest\/v1\/(finance_refund_decisions|finance_stripe_refund_executions)\?/.test(url)) {
    // F21 reads (eq. and gt. filters); Cash Flow never writes them.
    if (method !== "GET") return json({ message: "Cash Flow never writes F11 / F21 rows" }, 403);
    await tick();
    const u = new URL(url);
    const rows = world.sb[u.pathname.split("/").pop() as string] ?? [];
    const fs = [...u.searchParams].filter(([k]) => k !== "select" && k !== "order");
    return json(rows.filter((r: any) => fs.every(([k, v]) => (v.startsWith("gt.") ? Number(r[k]) > Number(v.slice(3)) : String(r[k] ?? "") === v.replace(/^eq\./, "")))).map((r: any) => ({ ...r })));
  }
  if (/\/rest\/v1\/finance_bank_balances\?/.test(url) && method !== "GET") return json({ message: "f17:history_is_append_only" }, 400);
  if (/\/rest\/v1\/finance_bank_balances\?/.test(url)) {
    // The shared fake PostgREST treats every parameter as a filter: apply the bounded-read limit here.
    const u = new URL(url);
    const limit = Number(u.searchParams.get("limit") ?? "0");
    u.searchParams.delete("limit");
    const res = await base(u.toString(), init);
    const rows = await res.json();
    return json(Array.isArray(rows) && limit ? rows.slice(0, limit) : rows, res.status);
  }
  return base(input, init);
}) as typeof fetch;

export const deps: CashFlowDeps = { ...supplierDeps, cashFlow: { random: (() => { let n = 0; return () => `bb${(++n).toString(16).padStart(10, "0")}`; })() } };
export const cashFlow = (q: Record<string, string> = {}, caller: any = mgr): Promise<any> => {
  const p = parseCashQuery("cash.read", new URLSearchParams(q), isTenantKey);
  return p.ok ? readCashFlow(deps, caller, { range: p.range, view: p.view }) : err(p);
};
export const balanceHistory = (caller: any = mgr): Promise<any> => readBalanceHistory(deps, caller) as Promise<any>;
export const balanceNew = (body: Record<string, unknown>, caller: any = mgr): Promise<any> => {
  const p = parseBalance(JSON.stringify(body), isTenantKey);
  return p.ok ? recordBankBalance(deps, caller, p.req) : err(p);
};
