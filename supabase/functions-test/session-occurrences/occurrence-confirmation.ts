/**
 * Session Occurrence delivery confirmation - PURE (Schedule prerequisite
 * before Finance F5; see TEST-ENV.md "Schedule prerequisite - delivery
 * confirmation writer"). No HTTP, Airtable, Supabase or Deno code.
 *
 * After an occurrence has passed, Management confirms ONE of the two
 * existing Schedule answers:
 *   1. Went as planned  -> Confirmation State "Confirmed",  Status "Completed"
 *   2. Something changed -> Confirmation State "Exception Recorded",
 *      Exception Reason (required), Exception At, and the STRUCTURED
 *      delivery result, expressed through the existing Status field:
 *        delivered = yes -> Status "Completed" (ran, with a change)
 *        delivered = no  -> Status "Cancelled" (did not run)
 *
 * Only existing Session Occurrences fields are written. Delivery truth is
 * never taken from Operational Notes or any other free text - the caller
 * must state it explicitly, and only the structured Status carries it.
 * Commercial consequences (partial value, not billable, ...) are Finance
 * overrides, never decided here.
 *
 * History: the occurrence's own existing stamp fields (Confirmed At /
 * Confirmed By User ID / Confirmed By Name Snapshot, and Exception At for
 * "something changed") - the same "Decided/Confirmed By" convention as
 * Register Completed By and Occurrence Financial Outcomes. Session History
 * stays structural only (Slice 9) and is never written here. A
 * confirmation is WRITE-ONCE: it can only start from the single
 * unconfirmed Scheduled state, so the previous state is always exactly
 * that state; there is no correction / reopen path in this slice, and a
 * different answer for an already-confirmed occurrence is refused (409).
 */

export const CONFIRMATION_CONTRACT = "schedule-occurrence-confirmation-v1";

export const CONFIRMATIONS = ["went_as_planned", "something_changed"] as const;
export type Confirmation = (typeof CONFIRMATIONS)[number];

/** Exactly the Session Occurrences "Exception Reason" choices (TEST schema). */
export const EXCEPTION_REASONS = ["Weather", "Venue", "Staffing", "Safeguarding / Emergency", "Client", "Other"] as const;
export type ExceptionReason = (typeof EXCEPTION_REASONS)[number];

export const OCC_FIELDS = {
  id: "Occurrence ID",
  session: "Session",
  date: "Date",
  start: "Start Date & Time",
  end: "End Date & Time",
  status: "Status",
  confirmation: "Confirmation State",
  confirmedAt: "Confirmed At",
  confirmedBy: "Confirmed By User ID",
  confirmedByName: "Confirmed By Name Snapshot",
  exceptionAt: "Exception At",
  exceptionReason: "Exception Reason",
} as const;

export const OCCURRENCE_ID_PATTERN = /^[A-Za-z0-9:_-]{1,80}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Compared case-insensitively - anything that could select an organisation, tenant or base. Same list as Finance F1 / Needs Attention. */
const TENANT_KEYS = new Set(
  [
    "organisation", "organisationId", "organisation_id", "organization", "organizationId", "organization_id",
    "org", "orgId", "org_id", "tenant", "tenantId", "tenant_id",
    "base", "baseId", "base_id", "airtableBase", "airtableBaseId", "airtable_base_id",
  ].map((k) => k.toLowerCase())
);
export const isTenantKey = (k: string) => TENANT_KEYS.has(k.toLowerCase());

// ---------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------

export type ConfirmRequest =
  | { occurrenceId: string; confirmation: "went_as_planned"; delivered: true; exceptionReason: null }
  | { occurrenceId: string; confirmation: "something_changed"; delivered: boolean; exceptionReason: ExceptionReason };

export type Invalid = { ok: false; httpStatus: 400; code: string; error: string };
const invalid = (code: string, error: string): Invalid => ({ ok: false, httpStatus: 400, code, error });

const BODY_KEYS = ["occurrenceId", "confirmation", "delivered", "exceptionReason"];

/**
 * POST /session-occurrences/confirm-occurrence body:
 *   { occurrenceId, confirmation: "went_as_planned" }
 *   { occurrenceId, confirmation: "something_changed", delivered: true|false, exceptionReason }
 * Tenant selectors are refused (400), never ignored; unknown keys are refused.
 */
export function parseConfirmBody(raw: string): { ok: true; req: ConfirmRequest } | Invalid {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return invalid("invalid_body", "Body must be valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("invalid_body", "Body must be a JSON object");
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b);
  if (keys.some(isTenantKey)) return invalid("tenant_param_rejected", "The organisation is taken from your profile and cannot be chosen in the request");
  const unknown = keys.filter((k) => !BODY_KEYS.includes(k));
  if (unknown.length) return invalid("unexpected_field", `Unexpected field(s): ${unknown.join(", ")}`);
  if (typeof b.occurrenceId !== "string" || !OCCURRENCE_ID_PATTERN.test(b.occurrenceId)) return invalid("invalid_input", "occurrenceId is required (the occurrence's Occurrence ID)");
  if (!(CONFIRMATIONS as readonly unknown[]).includes(b.confirmation)) return invalid("invalid_input", `confirmation must be one of: ${CONFIRMATIONS.join(", ")}`);
  if (b.confirmation === "went_as_planned") {
    if (b.delivered !== undefined && b.delivered !== true) return invalid("invalid_input", "went_as_planned means the session was delivered - use something_changed if it was not");
    if (b.exceptionReason !== undefined && b.exceptionReason !== null) return invalid("invalid_input", "went_as_planned takes no exceptionReason - use something_changed to record a change");
    return { ok: true, req: { occurrenceId: b.occurrenceId, confirmation: "went_as_planned", delivered: true, exceptionReason: null } };
  }
  if (typeof b.delivered !== "boolean") return invalid("invalid_input", "something_changed requires delivered: true (the session ran, with a change) or false (it did not run)");
  if (!(EXCEPTION_REASONS as readonly unknown[]).includes(b.exceptionReason)) return invalid("invalid_input", `something_changed requires exceptionReason, one of: ${EXCEPTION_REASONS.join(", ")}`);
  return { ok: true, req: { occurrenceId: b.occurrenceId, confirmation: "something_changed", delivered: b.delivered, exceptionReason: b.exceptionReason as ExceptionReason } };
}

// ---------------------------------------------------------------------
// Occurrence state
// ---------------------------------------------------------------------

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const selectName = (v: unknown): string | null => str(v && typeof v === "object" && typeof (v as any).name === "string" ? (v as any).name : v);

export interface OccurrenceState {
  occurrenceId: string;
  sessionRecordId: string | null;
  date: string | null;
  start: string | null;
  end: string | null;
  status: string | null;
  /** null = blank; blank and "Awaiting Confirmation" both mean not yet confirmed. */
  confirmationState: string | null;
  exceptionReason: string | null;
  confirmedAt: string | null;
  confirmedByName: string | null;
  exceptionAt: string | null;
}

export function occurrenceState(row: { fields: Record<string, any> }): OccurrenceState {
  const f = row.fields ?? {};
  const links = Array.isArray(f[OCC_FIELDS.session]) ? f[OCC_FIELDS.session].filter((x: unknown) => typeof x === "string") : [];
  return {
    occurrenceId: str(f[OCC_FIELDS.id]) ?? "",
    sessionRecordId: links.length === 1 ? links[0] : null,
    date: str(f[OCC_FIELDS.date]),
    start: str(f[OCC_FIELDS.start]),
    end: str(f[OCC_FIELDS.end]),
    status: selectName(f[OCC_FIELDS.status]),
    confirmationState: selectName(f[OCC_FIELDS.confirmation]),
    exceptionReason: selectName(f[OCC_FIELDS.exceptionReason]),
    confirmedAt: str(f[OCC_FIELDS.confirmedAt]),
    confirmedByName: str(f[OCC_FIELDS.confirmedByName]),
    exceptionAt: str(f[OCC_FIELDS.exceptionAt]),
  };
}

const isUnconfirmed = (s: OccurrenceState) => s.confirmationState === null || s.confirmationState === "Awaiting Confirmation";

/**
 * Has the occurrence passed? Its End (else Start) instant is <= now; with
 * no times at all, its date is before today in the ORGANISATION's
 * timezone. Same rule Finance F4 uses to call an occurrence "not yet
 * delivered", so the two can never disagree about the future.
 */
export function hasPassed(s: OccurrenceState, now: Date, today: string): boolean {
  const endsAt = s.end ?? s.start;
  if (endsAt !== null) {
    const t = Date.parse(endsAt);
    if (!Number.isNaN(t)) return t <= now.getTime();
  }
  return s.date !== null && s.date < today;
}

/** The (Confirmation State, Status, Exception Reason) a request produces. */
export function targetOf(req: ConfirmRequest): { confirmationState: string; status: string; exceptionReason: string | null } {
  if (req.confirmation === "went_as_planned") return { confirmationState: "Confirmed", status: "Completed", exceptionReason: null };
  return { confirmationState: "Exception Recorded", status: req.delivered ? "Completed" : "Cancelled", exceptionReason: req.exceptionReason };
}

/** What an already-confirmed occurrence says, as a request - null when its stored confirmation is not one this writer produces. */
export function confirmationOf(s: OccurrenceState): { confirmation: Confirmation; delivered: boolean; exceptionReason: string | null } | null {
  if (s.confirmationState === "Confirmed" && s.status === "Completed") return { confirmation: "went_as_planned", delivered: true, exceptionReason: null };
  if (s.confirmationState === "Exception Recorded" && (s.status === "Completed" || s.status === "Cancelled")) {
    return { confirmation: "something_changed", delivered: s.status === "Completed", exceptionReason: s.exceptionReason };
  }
  return null;
}

export type Decision =
  | { kind: "write"; fields: Record<string, unknown> }
  | { kind: "noop" }
  | { kind: "refuse"; httpStatus: 409; code: string; error: string };

const refuse = (code: string, error: string): Decision => ({ kind: "refuse", httpStatus: 409, code, error });

/**
 * The whole transition rule. Normal confirmation applies only to an
 * occurrence that (a) has passed, (b) is still Scheduled, and (c) has not
 * been confirmed. An identical repeat of the confirmation it already holds
 * is a no-op; anything else on a confirmed occurrence is refused - no
 * history is ever rewritten.
 */
export function decide(state: OccurrenceState, req: ConfirmRequest, ctx: { now: Date; today: string; actor: { userId: string; name: string | null } }): Decision {
  if (!state.sessionRecordId) return refuse("occurrence_invalid", "The occurrence is not linked to exactly one Session - Schedule data must be corrected first");
  if (!state.date || !ISO_DATE_RE.test(state.date)) return refuse("occurrence_invalid", "The occurrence has no valid date - Schedule data must be corrected first");

  if (!isUnconfirmed(state)) {
    const held = confirmationOf(state);
    const target = targetOf(req);
    if (held && held.confirmation === req.confirmation && held.delivered === req.delivered && held.exceptionReason === target.exceptionReason) return { kind: "noop" };
    return refuse(
      "occurrence_already_confirmed",
      `This occurrence was already confirmed (${state.confirmationState}, ${state.status ?? "no status"}${state.confirmedByName ? ` by ${state.confirmedByName}` : ""}). Changing a confirmation needs a correction path, which does not exist yet`
    );
  }

  if (state.status === "Cancelled" || state.status === "Postponed") {
    return refuse("occurrence_not_confirmable", `A ${state.status.toLowerCase()} occurrence cannot be confirmed through the normal route - it did not run on this date`);
  }
  if (state.status !== "Scheduled") {
    return refuse("occurrence_not_confirmable", `Only a Scheduled occurrence can be confirmed (this one is ${state.status ?? "without a status"}) - Schedule data must be corrected first`);
  }
  if (!hasPassed(state, ctx.now, ctx.today)) return refuse("occurrence_not_passed", "This occurrence has not happened yet - it can only be confirmed after it has passed");

  const t = targetOf(req);
  const at = ctx.now.toISOString();
  const fields: Record<string, unknown> = {
    [OCC_FIELDS.confirmation]: t.confirmationState,
    [OCC_FIELDS.status]: t.status,
    [OCC_FIELDS.confirmedAt]: at,
    [OCC_FIELDS.confirmedBy]: ctx.actor.userId,
    [OCC_FIELDS.confirmedByName]: ctx.actor.name ?? ctx.actor.userId,
  };
  if (req.confirmation === "something_changed") {
    fields[OCC_FIELDS.exceptionReason] = t.exceptionReason;
    fields[OCC_FIELDS.exceptionAt] = at;
  }
  return { kind: "write", fields };
}

// ---------------------------------------------------------------------
// Public view - no Airtable record ids
// ---------------------------------------------------------------------

export function publicConfirmation(s: OccurrenceState) {
  const held = isUnconfirmed(s) ? null : confirmationOf(s);
  return {
    occurrenceId: s.occurrenceId,
    date: s.date,
    status: s.status,
    confirmationState: s.confirmationState ?? "Awaiting Confirmation",
    confirmation: held?.confirmation ?? null,
    delivered: held ? held.delivered : null,
    exceptionReason: s.exceptionReason,
    confirmedAt: s.confirmedAt,
    confirmedBy: s.confirmedByName,
    exceptionAt: s.exceptionAt,
  };
}

/** The state after `fields` are applied (for the response, without a re-read). */
export function applyFields(s: OccurrenceState, fields: Record<string, unknown>): OccurrenceState {
  const pick = (k: string, cur: string | null) => (Object.prototype.hasOwnProperty.call(fields, k) ? (fields[k] as string | null) : cur);
  return {
    ...s,
    status: pick(OCC_FIELDS.status, s.status),
    confirmationState: pick(OCC_FIELDS.confirmation, s.confirmationState),
    exceptionReason: pick(OCC_FIELDS.exceptionReason, s.exceptionReason),
    confirmedAt: pick(OCC_FIELDS.confirmedAt, s.confirmedAt),
    confirmedByName: pick(OCC_FIELDS.confirmedByName, s.confirmedByName),
    exceptionAt: pick(OCC_FIELDS.exceptionAt, s.exceptionAt),
  };
}

// ---------------------------------------------------------------------
// Organisation (server-derived; copied verbatim in shape from
// needs-attention/needs-attention.ts resolveOrganisation - the caller's
// profile organisation_id, exactly one Active Organisation & Branding row)
// ---------------------------------------------------------------------

export interface OrganisationContext {
  organisationId: string;
  timezone: string;
}

export function resolveOrganisation(
  profileOrganisationId: string | null | undefined,
  orgRecords: { id: string; fields: Record<string, any> }[]
): { ok: true; organisation: OrganisationContext } | { ok: false; code: "organisation_not_found" | "organisation_ambiguous"; error: string } {
  const wanted = typeof profileOrganisationId === "string" ? profileOrganisationId.trim() : "";
  if (!wanted) return { ok: false, code: "organisation_not_found", error: "Your profile has no organisation" };
  const matches = orgRecords.filter((r) => r.fields?.["Active"] === true && str(r.fields?.["Organisation ID"]) === wanted);
  if (matches.length === 0) return { ok: false, code: "organisation_not_found", error: `No active organisation matches ${wanted}` };
  if (matches.length > 1) return { ok: false, code: "organisation_ambiguous", error: `${matches.length} active organisations match ${wanted}` };
  return { ok: true, organisation: { organisationId: wanted, timezone: str(matches[0].fields["Timezone"]) ?? "Europe/London" } };
}

/** The calendar date "now" in the organisation's timezone. */
export function todayIn(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Only an active Management profile may confirm - Coach / Parent / inactive / pending never can. */
export function isManagementCaller(caller: { role: string | null; active: boolean }): boolean {
  return caller.role === "management" && caller.active === true;
}
