/**
 * Test-suite copy of the canonical finance/finance-cash-flow-repository.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). Only import paths adjusted:
 * ./orchestrator.ts -> ./finance-orchestrator.ts; ./repository.ts -> ./finance-repository.ts.
 */
/**
 * Cash Position / Cash Flow - storage (Finance Foundation F17; see
 * TEST-ENV.md "Finance Foundation - F17").
 *
 * F17 owns ONE table: finance_bank_balances - the append-only history of
 * Management-entered bank balances (never updated, never deleted). Its only
 * write is ONE database function call, finance_bank_balance_record, which
 * inserts the next row (re-checking that nobody recorded one in between) and
 * writes its finance_audit_events row in the same transaction.
 *
 * Every other Cash Flow input is read through the owning slice's own
 * repository (F2 settings, F7 receivables, F12 coach months, F13 / F14
 * suppliers, F15 employment): Cash Flow never writes them.
 */
import type { GrantStoreConfig } from "./finance-repository.ts";
import type { BankBalance } from "./finance-cash-flow.ts";

export const BALANCE_TABLE = "finance_bank_balances";
export const BALANCE_RPC = "finance_bank_balance_record";
/** A bounded read: more balance rows than this fails loudly instead of being cut short. */
export const BALANCE_READ_LIMIT = 1000;

function headers(svc: GrantStoreConfig): Record<string, string> {
  return { apikey: svc.serviceRoleKey, Authorization: `Bearer ${svc.serviceRoleKey}`, "Content-Type": "application/json", Accept: "application/json" };
}
const rest = (svc: GrantStoreConfig, path: string) => `${svc.supabaseUrl.replace(/\/+$/, "")}/rest/v1/${path}`;
const eq = (v: string) => `eq.${encodeURIComponent(v)}`;
const int = (v: unknown, what: string): number => {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) throw new Error(`${what}: not an integer`);
  return n;
};

export const balanceFromRow = (r: Record<string, any>): BankBalance => ({
  organisationId: r.organisation_id,
  balanceId: r.balance_id,
  sequence: int(r.sequence, "sequence"),
  amountMinor: int(r.amount_minor, "amount_minor"),
  asAtDate: String(r.as_at_date).slice(0, 10),
  note: r.note ?? null,
  recordedAt: new Date(String(r.recorded_at)).toISOString(),
  recordedBy: r.recorded_by,
});
export const balanceRow = (b: BankBalance) => ({
  organisation_id: b.organisationId,
  balance_id: b.balanceId,
  sequence: b.sequence,
  amount_minor: b.amountMinor,
  as_at_date: b.asAtDate,
  note: b.note,
  recorded_at: b.recordedAt,
  recorded_by: b.recordedBy,
});

/** The organisation's whole balance history, oldest entry first. */
export async function loadBalances(svc: GrantStoreConfig, organisationId: string): Promise<BankBalance[]> {
  const res = await fetch(`${rest(svc, BALANCE_TABLE)}?organisation_id=${eq(organisationId)}&select=*&order=sequence.asc&limit=${BALANCE_READ_LIMIT + 1}`, { headers: headers(svc) });
  if (!res.ok) throw new Error(`${BALANCE_TABLE} read failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error(`${BALANCE_TABLE} read returned an unexpected shape`);
  if (rows.length > BALANCE_READ_LIMIT) throw new Error(`${BALANCE_TABLE}: more than ${BALANCE_READ_LIMIT} rows - refusing a truncated history`);
  if (rows.some((r) => r.organisation_id !== organisationId)) throw new Error(`${BALANCE_TABLE} read returned another organisation's row`);
  return rows.map(balanceFromRow);
}

/** A refused balance write: the database function's own rule code (f17:...), nothing written. */
export class BalanceRefusal extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
/** Inserts the next balance row + its audit row in one transaction; refused when the latest sequence is no longer `expectedSequence`. */
export async function recordBalance(svc: GrantStoreConfig, b: BankBalance, expectedSequence: number, events: Record<string, unknown>[]): Promise<unknown> {
  const res = await fetch(rest(svc, `rpc/${BALANCE_RPC}`), { method: "POST", headers: headers(svc), body: JSON.stringify({ p_balance: balanceRow(b), p_expected_sequence: expectedSequence, p_events: events }) });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = JSON.parse(text).message ?? text;
    } catch {
      /* keep the raw text */
    }
    const mm = /f17:([a-z_]+)/.exec(String(msg));
    if (mm) throw new BalanceRefusal(mm[1]);
    if (/duplicate key|unique/i.test(String(msg))) throw new BalanceRefusal("balance_changed");
    throw new Error(`${BALANCE_RPC} failed: ${res.status} ${text}`);
  }
  return text ? JSON.parse(text) : null;
}
