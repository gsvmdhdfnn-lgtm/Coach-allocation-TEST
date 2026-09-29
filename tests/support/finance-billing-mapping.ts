/**
 * Test-suite copy of the canonical finance/finance-billing-mapping.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). No changes.
 */
/**
 * Finance occurrence billing - storage mapping, PURE (Finance Foundation F4;
 * see TEST-ENV.md "Finance Foundation - F4"). Translates the transitional
 * TEST Airtable rows F4 reads or owns to/from the domain in
 * finance-billing.ts. The rest of the Finance code never sees an Airtable
 * field name.
 *
 *   - Session Occurrences / Sessions: owned by Schedule, READ ONLY here.
 *     Only the facts F4 needs are mapped; nothing is ever written back.
 *   - Finance Occurrence Billing Overrides: Finance-owned, per organisation.
 *     A row is only ever created, or closed (Removed At / Superseded By) -
 *     never edited in place or deleted (except as the compensating undo of
 *     a row created by the same request).
 *
 * Every override row is validated on read; a row that does not validate
 * makes the organisation's override data INVALID (409) - it is never
 * skipped or guessed (same rule as F3).
 */
import type { Minor } from "./finance-money.ts";
import { isIsoDate } from "./finance-effective-dating.ts";
import { ID_PATTERNS, MAX_BILLABLE_QUANTITY, MAX_UNIT_AMOUNT_MINOR, REASON_MAX } from "./finance-commercial.ts";
import type { Row } from "./finance-commercial-mapping.ts";
import { type OccurrenceFacts, type Override, type OverrideKind, OCCURRENCE_ID_PATTERN } from "./finance-billing.ts";

export const BILLING_TABLES = {
  occurrences: "Session Occurrences",
  sessions: "Sessions",
  overrides: "Finance Occurrence Billing Overrides",
} as const;

export const FB = {
  org: "Organisation",
  occurrence: {
    id: "Occurrence ID",
    session: "Session",
    date: "Date",
    start: "Start Date & Time",
    end: "End Date & Time",
    status: "Status",
    confirmation: "Confirmation State",
    exceptionReason: "Exception Reason",
    changeState: "Schedule Change State",
  },
  session: { id: "Session ID", name: "Session Name", financeServiceId: "Finance Service ID" },
  override: {
    id: "Override ID",
    occurrenceId: "Occurrence ID",
    occurrenceDate: "Occurrence Date",
    sessionId: "Session ID",
    serviceId: "Finance Service ID",
    termsId: "Commercial Terms ID",
    kind: "Kind",
    quantity: "Quantity",
    amount: "Amount (Minor Units)",
    reason: "Reason",
    createdBy: "Created By User ID",
    createdAt: "Created At",
    removedAt: "Removed At",
    removedBy: "Removed By User ID",
    removalReason: "Removal Reason",
    supersededBy: "Superseded By",
  },
} as const;

const KIND: Record<OverrideKind, string> = { not_billable: "Not billable", quantity: "Quantity", amount: "Amount" };

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const links = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
const selectName = (v: unknown): string | null => str(v && typeof v === "object" && typeof (v as any).name === "string" ? (v as any).name : v);

// ----- Schedule rows (read only) -----

/**
 * One occurrence plus its Session. `session` is the Session row the
 * occurrence links to (null = the link is missing or did not resolve).
 * A malformed row becomes `problem`, which resolution reports as
 * configuration_error - never a guessed value.
 */
export function occurrenceFacts(occ: Row, session: Row | null): OccurrenceFacts {
  const f = occ.fields ?? {};
  const o = FB.occurrence;
  const sessionLinks = links(f[o.session]);
  const sf = session?.fields ?? {};
  const problems: string[] = [];
  const occurrenceId = str(f[o.id]) ?? "";
  if (!OCCURRENCE_ID_PATTERN.test(occurrenceId)) problems.push("the occurrence has no valid Occurrence ID");
  if (sessionLinks.length !== 1) problems.push(`the occurrence links ${sessionLinks.length} sessions (exactly one expected)`);
  else if (!session || session.id !== sessionLinks[0]) problems.push("the occurrence's session could not be read");
  const date = str(f[o.date]) ?? "";
  if (!isIsoDate(date)) problems.push("the occurrence has no valid date");
  const rawRef = session ? sf[FB.session.financeServiceId] : null;
  return {
    occurrenceId,
    sessionId: session ? str(sf[FB.session.id]) : null,
    sessionName: session ? str(sf[FB.session.name]) : null,
    financeServiceRef: str(rawRef),
    date,
    start: str(f[o.start]),
    end: str(f[o.end]),
    status: selectName(f[o.status]),
    confirmationState: selectName(f[o.confirmation]),
    exceptionReason: selectName(f[o.exceptionReason]),
    scheduleChangeState: selectName(f[o.changeState]),
    problem: problems.length ? `Schedule data cannot be read safely: ${problems.join("; ")}` : null,
  };
}

/** The single Session record id an occurrence links to (null when not exactly one). */
export function occurrenceSessionRecordId(occ: Row): string | null {
  const l = links(occ.fields?.[FB.occurrence.session]);
  return l.length === 1 ? l[0] : null;
}

// ----- Overrides (Finance-owned) -----

type ParsedOverride = { ok: true; override: Override; recordId: string } | { ok: false; problem: string };

export function overrideFromRow(r: Row): ParsedOverride {
  const f = r.fields ?? {};
  const x = FB.override;
  const id = str(f[x.id]);
  if (!id || !ID_PATTERNS.override.test(id)) return { ok: false, problem: `override row ${r.id}: bad Override ID` };
  const bad = (what: string): ParsedOverride => ({ ok: false, problem: `override ${id}: ${what}` });
  if (links(f[FB.org]).length !== 1) return bad("must link exactly one organisation");
  const occurrenceId = str(f[x.occurrenceId]);
  if (!occurrenceId || !OCCURRENCE_ID_PATTERN.test(occurrenceId)) return bad("invalid Occurrence ID");
  const kindName = selectName(f[x.kind]);
  const kind = (Object.keys(KIND) as OverrideKind[]).find((k) => KIND[k] === kindName);
  if (!kind) return bad("invalid Kind");
  const q = f[x.quantity] ?? null;
  const a = f[x.amount] ?? null;
  if (kind === "quantity" ? !(Number.isInteger(q) && q >= 0 && q <= MAX_BILLABLE_QUANTITY) : q !== null) return bad("Quantity does not match the kind");
  if (kind === "amount" ? !(Number.isInteger(a) && a >= 0 && a <= MAX_UNIT_AMOUNT_MINOR) : a !== null) return bad("Amount does not match the kind");
  const reason = str(f[x.reason]);
  if (!reason || reason.length > REASON_MAX) return bad("a reason is required");
  const serviceId = str(f[x.serviceId]);
  const termsId = str(f[x.termsId]);
  if (serviceId !== null && !ID_PATTERNS.service.test(serviceId)) return bad("invalid Finance Service ID");
  if (termsId !== null && !ID_PATTERNS.terms.test(termsId)) return bad("invalid Commercial Terms ID");
  const date = f[x.occurrenceDate] ?? null;
  if (date !== null && !isIsoDate(date)) return bad("invalid Occurrence Date");
  const removedAt = str(f[x.removedAt]);
  const supersededBy = str(f[x.supersededBy]);
  if (supersededBy !== null && !ID_PATTERNS.override.test(supersededBy)) return bad("invalid Superseded By");
  if (supersededBy !== null && removedAt === null) return bad("superseded but not closed");
  return {
    ok: true,
    recordId: r.id,
    override: {
      overrideId: id,
      occurrenceId,
      kind,
      quantity: kind === "quantity" ? (q as number) : null,
      amountMinor: kind === "amount" ? (a as Minor) : null,
      reason,
      serviceId,
      termsId,
      createdAt: str(f[x.createdAt]),
      removedAt,
      removalReason: str(f[x.removalReason]),
      supersededBy,
    },
  };
}

export type StoredOverride = { recordId: string; value: Override };

/** Validates every row (the caller's organisation only - enforced by the repository and re-checked here). */
export function buildOverrides(rows: Row[], organisationRecordId: string): { ok: true; overrides: StoredOverride[] } | { ok: false; error: string } {
  const problems: string[] = [];
  const out: StoredOverride[] = [];
  for (const r of rows) {
    const org = links(r.fields?.[FB.org]);
    if (org.length !== 1 || org[0] !== organisationRecordId) {
      problems.push(`override row ${r.id} does not belong to this organisation`);
      continue;
    }
    const p = overrideFromRow(r);
    if (p.ok) out.push({ recordId: p.recordId, value: p.override });
    else problems.push(p.problem);
  }
  const ids = out.map((o) => o.value.overrideId);
  for (const d of ids.filter((x, i) => ids.indexOf(x) !== i)) problems.push(`duplicate id ${d}`);
  if (problems.length) return { ok: false, error: `Stored billing overrides are not valid (${problems.slice(0, 3).join("; ")}${problems.length > 3 ? `; +${problems.length - 3} more` : ""}) - they must be corrected before use` };
  return { ok: true, overrides: out };
}

export function overrideCreateFields(
  o: Override,
  create: { orgRecordId: string; occurrenceDate: string; sessionId: string | null; userId: string; at: string }
): Record<string, unknown> {
  const x = FB.override;
  return {
    [FB.org]: [create.orgRecordId],
    [x.id]: o.overrideId,
    [x.occurrenceId]: o.occurrenceId,
    [x.occurrenceDate]: create.occurrenceDate,
    [x.sessionId]: create.sessionId,
    [x.serviceId]: o.serviceId,
    [x.termsId]: o.termsId,
    [x.kind]: KIND[o.kind],
    [x.quantity]: o.quantity,
    [x.amount]: o.amountMinor,
    [x.reason]: o.reason,
    [x.createdBy]: create.userId,
    [x.createdAt]: create.at,
  };
}

/** The only edit ever made to an existing override row: closing it (removed or superseded). Its undo clears the same fields. */
export function overrideCloseFields(close: { at: string; userId: string; reason: string; supersededBy: string | null } | null): Record<string, unknown> {
  const x = FB.override;
  return close
    ? { [x.removedAt]: close.at, [x.removedBy]: close.userId, [x.removalReason]: close.reason, [x.supersededBy]: close.supersededBy }
    : { [x.removedAt]: null, [x.removedBy]: null, [x.removalReason]: null, [x.supersededBy]: null };
}
