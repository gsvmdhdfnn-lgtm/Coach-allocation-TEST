/**
 * Test-suite copy of the canonical finance/finance-money.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). No changes.
 */
/**
 * Finance money + VAT kernel - PURE (Finance Foundation F2; see TEST-ENV.md
 * "Finance Foundation - F2"). No HTTP, Airtable, Supabase or Deno code.
 *
 * Money:
 *   - Every amount is an integer number of MINOR units (pence for GBP).
 *     No function here accepts or returns a fractional amount.
 *   - Decimal input is only ever parsed from a STRING ("12.34"), never from
 *     a JS number, so a float can never silently enter a calculation.
 *   - Amounts are bounded by MAX_MINOR (GBP 1,000,000,000.00) so every
 *     intermediate product stays exact.
 *
 * VAT (locked F2 rule):
 *   - Rates are integer BASIS POINTS: 2000 = 20%, 1750 = 17.5%, 0 = 0%.
 *     No rate is assumed anywhere in this file.
 *   - plus_vat:     input is NET.   vat = round(net * rate / 10000);         gross = net + vat
 *   - vat_included: input is GROSS. vat = round(gross * rate / (10000+rate)); net = gross - vat
 *   - no_vat:       vat = 0;        net = gross = input (rate must be absent or 0)
 *   - ONE rounding rule: round half away from zero, to the whole minor unit,
 *     applied once, to the VAT figure only. Net/gross are then derived by
 *     integer addition/subtraction, so gross = net + vat holds exactly for
 *     every input. Negative inputs mirror positive ones exactly.
 */

export const CURRENCY = "GBP" as const;
export const MINOR_UNITS_PER_MAJOR = 100;
/** GBP 1,000,000,000.00 - far above any Hub amount, far below 2^53 / 10000. */
export const MAX_MINOR = 100_000_000_000;
export const MAX_RATE_BASIS_POINTS = 10_000;

export type Minor = number;

export function isMinor(v: unknown): v is Minor {
  return typeof v === "number" && Number.isSafeInteger(v) && Math.abs(v) <= MAX_MINOR;
}

export type MoneyResult = { ok: true; minor: Minor } | { ok: false; error: string };

const MONEY_RE = /^(-)?(\d{1,10})(?:\.(\d{1,2}))?$/;

/** "12", "12.3", "12.34", "-0.05" -> minor units. Numbers, 3+ decimals, commas, currency symbols and blanks are refused. */
export function parseMoney(input: unknown): MoneyResult {
  if (typeof input !== "string") return { ok: false, error: "Money must be given as a decimal string, e.g. \"12.34\"" };
  const m = MONEY_RE.exec(input.trim());
  if (!m) return { ok: false, error: "Money must look like 12 or 12.34 (at most two decimal places)" };
  const major = Number(m[2]);
  const minorPart = Number((m[3] ?? "").padEnd(2, "0"));
  const abs = major * MINOR_UNITS_PER_MAJOR + minorPart;
  if (abs > MAX_MINOR) return { ok: false, error: "Amount is too large" };
  return { ok: true, minor: m[1] && abs !== 0 ? -abs : abs };
}

/** Minor units -> "1234.50" / "-0.05". Throws on a non-integer (a programming error, never user input). */
export function formatMinor(minor: Minor): string {
  if (!isMinor(minor)) throw new Error(`formatMinor: not an integer minor amount: ${minor}`);
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const major = Math.floor(abs / MINOR_UNITS_PER_MAJOR);
  const rest = abs % MINOR_UNITS_PER_MAJOR;
  return `${sign}${major}.${String(rest).padStart(2, "0")}`;
}

/** Exact integer sum; throws if any item is not a bounded integer or the total leaves the bound. */
export function sumMinor(values: readonly Minor[]): Minor {
  let total = 0;
  for (const v of values) {
    if (!isMinor(v)) throw new Error(`sumMinor: not an integer minor amount: ${v}`);
    total += v;
    if (Math.abs(total) > MAX_MINOR) throw new Error("sumMinor: total out of range");
  }
  return total;
}

// ---------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------

export function isRateBasisPoints(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_RATE_BASIS_POINTS;
}

const RATE_RE = /^(\d{1,3})(?:\.(\d{1,2}))?$/;

/** Percentage string -> basis points: "20" -> 2000, "17.5" -> 1750, "0" -> 0. At most 2 decimals, 0-100. */
export function parseRatePercent(input: unknown): { ok: true; basisPoints: number } | { ok: false; error: string } {
  if (typeof input !== "string") return { ok: false, error: "A VAT rate must be given as a percentage string, e.g. \"20\"" };
  const m = RATE_RE.exec(input.trim());
  if (!m) return { ok: false, error: "A VAT rate must look like 20 or 17.5 (at most two decimal places)" };
  const bp = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (bp > MAX_RATE_BASIS_POINTS) return { ok: false, error: "A VAT rate cannot exceed 100%" };
  return { ok: true, basisPoints: bp };
}

/** 2000 -> "20", 1750 -> "17.5", 5 -> "0.05". */
export function formatRatePercent(bp: number): string {
  if (!isRateBasisPoints(bp)) throw new Error(`formatRatePercent: invalid basis points: ${bp}`);
  const whole = Math.floor(bp / 100);
  const frac = bp % 100;
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}

// ---------------------------------------------------------------------
// VAT
// ---------------------------------------------------------------------

export const VAT_TREATMENTS = ["plus_vat", "vat_included", "no_vat"] as const;
export type VatTreatment = (typeof VAT_TREATMENTS)[number];

export function isVatTreatment(v: unknown): v is VatTreatment {
  return typeof v === "string" && (VAT_TREATMENTS as readonly string[]).includes(v);
}

/** Integer division rounded half away from zero (exact - BigInt). */
export function divRoundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("divRoundHalfAwayFromZero: denominator must be positive");
  const neg = numerator < 0n;
  const n = neg ? -numerator : numerator;
  const q = n / denominator;
  const r = n % denominator;
  const rounded = r * 2n >= denominator ? q + 1n : q;
  return neg ? -rounded : rounded;
}

export interface VatInput {
  /** NET for plus_vat, GROSS for vat_included, the amount itself for no_vat. */
  amountMinor: Minor;
  treatment: VatTreatment;
  /** Required for plus_vat / vat_included; must be absent, null or 0 for no_vat. */
  rateBasisPoints?: number | null;
}

export interface VatBreakdown {
  treatment: VatTreatment;
  rateBasisPoints: number;
  netMinor: Minor;
  vatMinor: Minor;
  grossMinor: Minor;
}

export type VatResult = ({ ok: true } & VatBreakdown) | { ok: false; code: "invalid_amount" | "invalid_treatment" | "invalid_rate" | "rate_with_no_vat"; error: string };

export function calculateVat(input: VatInput): VatResult {
  if (!isMinor(input.amountMinor)) return { ok: false, code: "invalid_amount", error: "Amount must be a whole number of pence" };
  if (!isVatTreatment(input.treatment)) return { ok: false, code: "invalid_treatment", error: `VAT treatment must be one of ${VAT_TREATMENTS.join(", ")}` };
  const amount = input.amountMinor;
  const rate = input.rateBasisPoints;

  if (input.treatment === "no_vat") {
    if (rate != null && rate !== 0) return { ok: false, code: "rate_with_no_vat", error: "No VAT cannot carry a VAT rate" };
    return { ok: true, treatment: "no_vat", rateBasisPoints: 0, netMinor: amount, vatMinor: 0, grossMinor: amount };
  }

  if (!isRateBasisPoints(rate)) return { ok: false, code: "invalid_rate", error: "VAT rate must be whole basis points between 0 and 10000" };
  const a = BigInt(amount);
  const r = BigInt(rate);

  if (input.treatment === "plus_vat") {
    const vat = Number(divRoundHalfAwayFromZero(a * r, 10_000n));
    const gross = amount + vat;
    if (!isMinor(gross)) return { ok: false, code: "invalid_amount", error: "Amount is too large" };
    return { ok: true, treatment: "plus_vat", rateBasisPoints: rate, netMinor: amount, vatMinor: vat, grossMinor: gross };
  }

  const vat = Number(divRoundHalfAwayFromZero(a * r, 10_000n + r));
  return { ok: true, treatment: "vat_included", rateBasisPoints: rate, netMinor: amount - vat, vatMinor: vat, grossMinor: amount };
}
