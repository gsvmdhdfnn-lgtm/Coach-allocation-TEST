/**
 * Finance Foundation F2 - money / VAT kernel + effective-dating helper.
 * Run: node --experimental-strip-types tests/support/finance-kernel.test.ts
 *
 *   M   money representation (integer minor units, strict parsing, formatting, sums)
 *   V   VAT (plus / included / none, custom rates, rounding, zero, negatives, invalid input)
 *   E   effective dating (boundaries, open end, gaps, overlap ambiguity, malformed data)
 */
import {
  MAX_MINOR,
  calculateVat,
  divRoundHalfAwayFromZero,
  formatMinor,
  formatRatePercent,
  isMinor,
  parseMoney,
  parseRatePercent,
  sumMinor,
} from "./finance-money.ts";
import { findOverlaps, isIsoDate, resolveEffective } from "./finance-effective-dating.ts";

const R: [string, string, string?][] = [];
let failed = 0;
function ck(name: string, cond: unknown, extra?: string) {
  const ok = !!cond;
  if (!ok) failed++;
  R.push([ok ? "PASS" : "FAIL", name, extra]);
}
const throws = (f: () => unknown) => {
  try {
    f();
    return false;
  } catch {
    return true;
  }
};
const vat = (amountMinor: number, treatment: any, rateBasisPoints?: number | null) => calculateVat({ amountMinor, treatment, rateBasisPoints });
const ok = (r: ReturnType<typeof calculateVat>, net: number, v: number, gross: number) => r.ok && r.netMinor === net && r.vatMinor === v && r.grossMinor === gross;

// ===== M. Money =====
{
  const p = (s: unknown): any => {
    try {
      return parseMoney(s);
    } catch {
      return { ok: "threw" };
    }
  };
  ck("M1. \"12.34\" -> 1234 pence", (p("12.34") as any).minor === 1234);
  ck("M2. \"12\" -> 1200, \"12.3\" -> 1230, \"0.05\" -> 5", (p("12") as any).minor === 1200 && (p("12.3") as any).minor === 1230 && (p("0.05") as any).minor === 5);
  ck("M3. \"-0.05\" -> -5; \"-0\" -> 0 (never -0)", (p("-0.05") as any).minor === -5 && Object.is((p("-0") as any).minor, 0));
  ck("M4. A JS number is refused cleanly (floats never enter)", p(12.34).ok === false && p(12).ok === false);
  ck("M5. Three decimals, commas, symbols, blanks, exponent, '.5', '5.' are refused", ["1.234", "1,000", "£5", "", " ", "1e3", ".5", "5.", "abc", "+5"].every((s) => p(s).ok === false));
  ck("M6. Above the bound is refused; the bound itself is accepted", !p("1000000000.01").ok && (p("1000000000.00") as any).minor === MAX_MINOR);
  ck("M7. 0.1 + 0.2 style drift cannot happen: 10p + 20p = 30p exactly", sumMinor([(p("0.10") as any).minor, (p("0.20") as any).minor]) === 30);
  ck("M8. formatMinor: 123450 -> 1234.50, 5 -> 0.05, -5 -> -0.05, 0 -> 0.00", formatMinor(123450) === "1234.50" && formatMinor(5) === "0.05" && formatMinor(-5) === "-0.05" && formatMinor(0) === "0.00");
  ck("M9. formatMinor/sumMinor throw on fractional amounts", throws(() => formatMinor(1.5)) && throws(() => sumMinor([1, 0.5])));
  ck("M10. sumMinor throws when the total leaves the bound", throws(() => sumMinor([MAX_MINOR, 1])));
  ck("M11. isMinor: integers only, bounded, no NaN/Infinity/strings", isMinor(0) && isMinor(-1) && !isMinor(1.1) && !isMinor(NaN) && !isMinor(Infinity) && !isMinor("1") && !isMinor(MAX_MINOR + 1));
  ck("M12. parse/format round-trip for every penny 0.00-2.00", Array.from({ length: 201 }, (_, i) => i).every((i) => (p(formatMinor(i)) as any).minor === i));
}

// ===== V. VAT =====
{
  ck("V1. Plus VAT 20%: net 10.00 -> VAT 2.00, gross 12.00", ok(vat(1000, "plus_vat", 2000), 1000, 200, 1200));
  ck("V2. VAT included 20%: gross 12.00 -> net 10.00, VAT 2.00", ok(vat(1200, "vat_included", 2000), 1000, 200, 1200));
  ck("V3. No VAT: net = gross = input, VAT 0", ok(vat(1234, "no_vat"), 1234, 0, 1234) && ok(vat(1234, "no_vat", 0), 1234, 0, 1234));
  ck("V4. No VAT with a non-zero rate is refused (never silently ignored)", !vat(1000, "no_vat", 2000).ok && (vat(1000, "no_vat", 2000) as any).code === "rate_with_no_vat");
  ck("V5. Custom rate 5%: plus 9.99 -> VAT 0.50 (0.4995 half-up), gross 10.49", ok(vat(999, "plus_vat", 500), 999, 50, 1049));
  ck("V6. Custom rate 17.5%: included 10.00 -> VAT 1.49 (148.936..), net 8.51", ok(vat(1000, "vat_included", 1750), 851, 149, 1000));
  ck("V7. Rounding half away from zero: plus 20% on 0.01..0.04 -> VAT 0,0,1,1 (0.2p, 0.4p, 0.6p, 0.8p)", [1, 2, 3, 4].map((n) => (vat(n, "plus_vat", 2000) as any).vatMinor).join() === "0,0,1,1");
  ck("V8. Exact half rounds up: plus 10% on 0.05 -> 0.5p -> 1p; plus 50% on 0.01 -> 1p", (vat(5, "plus_vat", 1000) as any).vatMinor === 1 && (vat(1, "plus_vat", 5000) as any).vatMinor === 1);
  ck("V9. Zero amount -> all zeros for every treatment", ok(vat(0, "plus_vat", 2000), 0, 0, 0) && ok(vat(0, "vat_included", 2000), 0, 0, 0) && ok(vat(0, "no_vat"), 0, 0, 0));
  ck("V10. Zero rate (zero-rated) -> VAT 0 under plus and included", ok(vat(1000, "plus_vat", 0), 1000, 0, 1000) && ok(vat(1000, "vat_included", 0), 1000, 0, 1000));
  let reconciles = true;
  let mirrors = true;
  for (const rate of [0, 1, 500, 1750, 2000, 3333, 10000]) {
    for (let a = -300; a <= 3000; a += 7) {
      for (const t of ["plus_vat", "vat_included"]) {
        const r = vat(a, t, rate) as any;
        const m = vat(-a, t, rate) as any;
        if (!r.ok || r.grossMinor !== r.netMinor + r.vatMinor || ![r.netMinor, r.vatMinor, r.grossMinor].every(Number.isInteger)) reconciles = false;
        if (!m.ok || m.vatMinor !== (r.vatMinor === 0 ? 0 : -r.vatMinor) || m.netMinor !== (r.netMinor === 0 ? 0 : -r.netMinor)) mirrors = false;
      }
    }
  }
  ck("V11. gross = net + VAT exactly, integers only, across 7 rates x 472 amounts x 2 treatments", reconciles);
  ck("V12. Negative amounts (credits) mirror positive ones exactly", mirrors);
  ck("V13. Invalid amount (fraction / string / NaN / out of bound) is refused", [1.5, NaN, "100" as any, MAX_MINOR + 1].every((a) => !vat(a, "plus_vat", 2000).ok));
  ck("V14. Invalid rate (fraction, negative, > 10000, missing) is refused for plus/included", [20.5, -1, 10001, null, undefined].every((r) => !vat(1000, "plus_vat", r as any).ok && !vat(1000, "vat_included", r as any).ok));
  ck("V15. Unknown treatment is refused", !vat(1000, "exempt", 2000).ok && !vat(1000, "PLUS_VAT", 2000).ok);
  ck("V16. No rate is assumed: plus/included without a rate fail instead of defaulting to 20%", !vat(1000, "plus_vat").ok && !vat(1000, "vat_included").ok);
  ck("V17. Large amounts stay exact (GBP 1bn net at 20% -> VAT 200,000,000.00)", ok(vat(MAX_MINOR, "vat_included", 2000), 83333333333, 16666666667, MAX_MINOR) && !vat(MAX_MINOR, "plus_vat", 2000).ok);
  ck("V18. divRoundHalfAwayFromZero: 5/2 -> 3, -5/2 -> -3, 4/3 -> 1, -4/3 -> -1", divRoundHalfAwayFromZero(5n, 2n) === 3n && divRoundHalfAwayFromZero(-5n, 2n) === -3n && divRoundHalfAwayFromZero(4n, 3n) === 1n && divRoundHalfAwayFromZero(-4n, 3n) === -1n);
  ck("V19. Rate strings: \"20\"->2000, \"17.5\"->1750, \"0\"->0, \"0.05\"->5; refuses \"20%\", \"-5\", \"100.01\", 20", (parseRatePercent("20") as any).basisPoints === 2000 && (parseRatePercent("17.5") as any).basisPoints === 1750 && (parseRatePercent("0") as any).basisPoints === 0 && (parseRatePercent("0.05") as any).basisPoints === 5 && ["20%", "-5", "100.01", "1.234"].every((s) => !parseRatePercent(s).ok) && !parseRatePercent(20).ok);
  ck("V20. formatRatePercent: 2000 -> 20, 1750 -> 17.5, 5 -> 0.05, 1234 -> 12.34", formatRatePercent(2000) === "20" && formatRatePercent(1750) === "17.5" && formatRatePercent(5) === "0.05" && formatRatePercent(1234) === "12.34");
}

// ===== E. Effective dating =====
{
  const A = { effectiveFrom: "2026-01-01", effectiveUntil: "2026-03-31", value: "A" };
  const B = { effectiveFrom: "2026-04-01", effectiveUntil: null, value: "B" };
  const set = [A, B];
  const at = (d: string, s: any[] = set) => resolveEffective(s, d) as any;
  ck("E1. Before the first entry -> none (no fallback)", at("2025-12-31").status === "none");
  ck("E2. Exactly on effectiveFrom -> that entry (inclusive)", at("2026-01-01").entry?.value === "A" && at("2026-04-01").entry?.value === "B");
  ck("E3. Between from and until -> that entry", at("2026-02-15").entry?.value === "A");
  ck("E4. Exactly on effectiveUntil -> that entry (inclusive)", at("2026-03-31").entry?.value === "A");
  ck("E5. After a closed entry ends with nothing following -> none", at("2026-04-01", [A]).status === "none");
  ck("E6. Open-ended entry applies indefinitely", at("2099-12-31").entry?.value === "B");
  const gap = [A, { effectiveFrom: "2026-05-01", value: "C" }];
  ck("E7. A gap between entries -> none inside the gap", at("2026-04-15", gap).status === "none");
  const overlap = [A, { effectiveFrom: "2026-03-31", value: "N", effectiveUntil: null }];
  const amb = at("2026-03-31", overlap);
  ck("E8. Overlap on the resolution date -> ambiguous with both entries (never the newest)", amb.status === "ambiguous" && amb.entries.length === 2);
  ck("E9. findOverlaps reports the overlapping pair; adjacent (until = day before from) is not an overlap", JSON.stringify(findOverlaps(overlap)) === "[[0,1]]" && findOverlaps(set).length === 0);
  ck("E10. Two open-ended entries always overlap", findOverlaps([{ effectiveFrom: "2026-01-01", value: 1 }, { effectiveFrom: "2030-01-01", value: 2 }]).length === 1);
  ck("E11. A malformed entry (bad date / until before from) makes resolution invalid, never skipped", at("2026-02-01", [A, { effectiveFrom: "2026-02-30", value: "X" }]).status === "invalid" && at("2026-02-01", [{ effectiveFrom: "2026-05-01", effectiveUntil: "2026-04-01", value: "X" }]).status === "invalid");
  ck("E12. A malformed query date is invalid", at("2026-2-1").status === "invalid" && at("").status === "invalid");
  ck("E13. isIsoDate: real calendar dates only (leap years handled)", isIsoDate("2028-02-29") && !isIsoDate("2026-02-29") && !isIsoDate("2026-13-01") && !isIsoDate("2026-00-10") && !isIsoDate("2026-04-31") && !isIsoDate(20260101));
  ck("E14. Single-day entry (from = until) applies on that day only", at("2026-06-01", [{ effectiveFrom: "2026-06-01", effectiveUntil: "2026-06-01", value: "D" }]).entry?.value === "D" && at("2026-06-02", [{ effectiveFrom: "2026-06-01", effectiveUntil: "2026-06-01", value: "D" }]).status === "none");
  ck("E15. Empty set -> none", at("2026-01-01", []).status === "none");
}

for (const [s, n, e] of R) console.log(`${s}  ${n}${e && s === "FAIL" ? `  [${e}]` : ""}`);
console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} checks passed`);
process.exit(failed ? 1 : 0);
