/**
 * Effective-dated value resolution - PURE (Finance Foundation F2; see
 * TEST-ENV.md "Finance Foundation - F2"). The one reusable helper later
 * Finance slices (service prices, billing rules, coach rates...) use to
 * answer "which value applies on this date".
 *
 * Contract:
 *   - Dates are calendar dates "YYYY-MM-DD" (validated as real dates).
 *   - effectiveFrom is REQUIRED and INCLUSIVE.
 *   - effectiveUntil is OPTIONAL and INCLUSIVE; absent/null = open-ended.
 *     effectiveUntil before effectiveFrom is invalid.
 *   - On a date covered by exactly one entry -> that entry.
 *   - On a date covered by none -> "none" (never a nearest/fallback guess).
 *   - On a date covered by MORE THAN ONE entry -> "ambiguous". Never picks
 *     the newest, the latest-created, or the first.
 *   - Any malformed entry makes the whole resolution "invalid" - a broken
 *     row is never skipped as if it did not exist.
 *   - findOverlaps() lets a write path reject an overlapping set before it
 *     is ever stored.
 */

export interface EffectiveDated<T> {
  effectiveFrom: string;
  effectiveUntil?: string | null;
  value: T;
}

export type EffectiveResolution<T> =
  | { status: "resolved"; entry: EffectiveDated<T> }
  | { status: "none" }
  | { status: "ambiguous"; entries: EffectiveDated<T>[] }
  | { status: "invalid"; error: string };

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date in YYYY-MM-DD form (rejects 2026-02-30, 2026-13-01, "2026-1-1"). */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = ISO_DATE_RE.exec(v);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= dim;
}

/** null when the entry is well-formed, else why not. */
export function entryError<T>(e: EffectiveDated<T>): string | null {
  if (!e || typeof e !== "object") return "entry is not an object";
  if (!isIsoDate(e.effectiveFrom)) return `effectiveFrom is not a valid YYYY-MM-DD date: ${String(e.effectiveFrom)}`;
  if (e.effectiveUntil != null) {
    if (!isIsoDate(e.effectiveUntil)) return `effectiveUntil is not a valid YYYY-MM-DD date: ${String(e.effectiveUntil)}`;
    if (e.effectiveUntil < e.effectiveFrom) return `effectiveUntil ${e.effectiveUntil} is before effectiveFrom ${e.effectiveFrom}`;
  }
  return null;
}

export function appliesOn<T>(e: EffectiveDated<T>, dateIso: string): boolean {
  if (dateIso < e.effectiveFrom) return false;
  if (e.effectiveUntil != null && dateIso > e.effectiveUntil) return false;
  return true;
}

export function resolveEffective<T>(entries: readonly EffectiveDated<T>[], dateIso: string): EffectiveResolution<T> {
  if (!isIsoDate(dateIso)) return { status: "invalid", error: `date is not a valid YYYY-MM-DD date: ${String(dateIso)}` };
  for (const e of entries) {
    const err = entryError(e);
    if (err) return { status: "invalid", error: err };
  }
  const hits = entries.filter((e) => appliesOn(e, dateIso));
  if (hits.length === 0) return { status: "none" };
  if (hits.length > 1) return { status: "ambiguous", entries: hits };
  return { status: "resolved", entry: hits[0] };
}

/** Every pair of entries whose inclusive ranges share at least one day (indices into `entries`). Malformed entries are reported by entryError, not here. */
export function findOverlaps<T>(entries: readonly EffectiveDated<T>[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      const aEndsBeforeB = a.effectiveUntil != null && a.effectiveUntil < b.effectiveFrom;
      const bEndsBeforeA = b.effectiveUntil != null && b.effectiveUntil < a.effectiveFrom;
      if (!aEndsBeforeB && !bEndsBeforeA) out.push([i, j]);
    }
  }
  return out;
}
