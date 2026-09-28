/**
 * Test-suite copy of the canonical needs-attention/exceptions.ts, kept in sync
 * by hand exactly like every other deployed copy. Only import paths adjusted:
 * ./needs-attention|repository|registry|staffing|cover|compliance|coach-schedule|exceptions|lock-client.ts become needs-attention-*.ts.
 */
/**
 * Needs Attention exception write path - PURE policy (Slice 5; see
 * TEST-ENV.md "Needs Attention Foundation - Slice 5"). No Airtable, HTTP
 * or Supabase code lives here: request validation, the create/revoke
 * decisions and the storage-neutral field sets are plain functions over
 * already-loaded data, so a later repository swap (Airtable -> Supabase)
 * only replaces repository.ts / orchestrator.ts wiring, never this file.
 *
 * Locked model:
 *   - An exception suppresses exactly ONE case: Organisation + Rule + Case
 *     Key. Session / Session Occurrence / Coach / Player links are
 *     context + audit only and never widen what is suppressed.
 *   - The client supplies only caseKey + reason (+ optional
 *     effectiveUntil). Organisation, rule, context links and approver
 *     identity are all derived server-side from the authenticated profile
 *     and the case as re-evaluated right now.
 *   - A case must genuinely exist now, the rule must Support Override and
 *     the organisation's effective Allow Override must be on.
 *   - Revoke sets Active = false and records who/when/why in dedicated
 *     revoke fields; the approval snapshot is never edited and nothing is
 *     ever deleted. Expiry is read-time only (no job flips Active).
 */
import {
  parseCaseKey,
  type ExceptionRow,
  type NeedsAttentionCase,
  type PlanEntry,
  type SuppressedCase,
} from "./needs-attention-engine.ts";

export const EXCEPTION_REASON_MAX = 2000;
export const CREATE_BODY_FIELDS = ["caseKey", "reason", "effectiveUntil"] as const;
export const REVOKE_BODY_FIELDS = ["exceptionId", "reason"] as const;
/** Tenant-looking keys are refused outright (same list as the GET route's query-parameter guard). */
export const TENANT_KEYS = ["organisation", "organisationId", "organisation_id", "organization", "organizationId", "org", "orgId", "tenant"];

const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;
/** An explicit instant: date + time + Z or a numeric offset. Bare dates / zone-less times are refused (ambiguous). */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const EXCEPTION_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

export type Invalid = { ok: false; httpStatus: 400; code: string; error: string };
const invalid = (code: string, error: string): Invalid => ({ ok: false, httpStatus: 400, code, error });

export interface Actor {
  userId: string;
  /** Snapshot shown in audit fields: profile display name, else account email, else the user id. */
  name: string;
}

/** Approver/revoker identity from the authenticated profile only - never from the request. */
export function actorFromProfile(p: { userId: string; displayName?: string | null; email?: string | null }): Actor {
  const name = (p.displayName ?? "").trim() || (p.email ?? "").trim() || p.userId;
  return { userId: p.userId, name };
}

function checkKeys(body: Record<string, unknown>, allowed: readonly string[]): Invalid | null {
  for (const k of Object.keys(body)) {
    if (TENANT_KEYS.includes(k)) return invalid("tenant_param_rejected", "The organisation is taken from your profile and cannot be chosen in the request");
    if (!allowed.includes(k)) return invalid("unexpected_field", `Unexpected field "${k}" - only ${allowed.join(", ")} may be sent; everything else is derived by the server`);
  }
  return null;
}

function checkReason(v: unknown, label: string): { ok: true; value: string } | Invalid {
  if (typeof v !== "string" || !v.trim()) return invalid("reason_required", `${label} is required`);
  const t = v.trim();
  if (t.length > EXCEPTION_REASON_MAX) return invalid("reason_too_long", `${label} must be at most ${EXCEPTION_REASON_MAX} characters`);
  return { ok: true, value: t };
}

export interface CreateRequest {
  caseKey: string;
  ruleKey: string;
  reason: string;
  /** Normalised ISO instant (UTC), or null = until revoked. */
  effectiveUntil: string | null;
}

export function parseCreateBody(body: unknown, now: Date): { ok: true; value: CreateRequest } | Invalid {
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("invalid_body", "Body must be a JSON object");
  const b = body as Record<string, unknown>;
  const bad = checkKeys(b, CREATE_BODY_FIELDS);
  if (bad) return bad;
  const parsed = parseCaseKey(b.caseKey);
  if (!parsed) return invalid("invalid_case_key", "caseKey must look like ruleKey|type:id[|type:id...]");
  const reason = checkReason(b.reason, "reason");
  if (!reason.ok) return reason;
  let effectiveUntil: string | null = null;
  if (b.effectiveUntil != null) {
    if (typeof b.effectiveUntil !== "string" || !ISO_INSTANT_RE.test(b.effectiveUntil)) {
      return invalid("invalid_effective_until", "effectiveUntil must be an ISO 8601 date-time with an explicit timezone (e.g. 2026-10-05T18:00:00+01:00 or ...Z)");
    }
    const t = Date.parse(b.effectiveUntil);
    if (Number.isNaN(t)) return invalid("invalid_effective_until", "effectiveUntil is not a real date-time");
    if (t <= now.getTime()) return invalid("effective_until_not_future", "effectiveUntil must be in the future");
    effectiveUntil = new Date(t).toISOString();
  }
  return { ok: true, value: { caseKey: b.caseKey as string, ruleKey: parsed.ruleKey, reason: reason.value, effectiveUntil } };
}

export interface RevokeRequest {
  /** The Exception ID value, or the exception's record id. */
  exceptionRef: string;
  reason: string;
}

export function parseRevokeBody(body: unknown): { ok: true; value: RevokeRequest } | Invalid {
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("invalid_body", "Body must be a JSON object");
  const b = body as Record<string, unknown>;
  const bad = checkKeys(b, REVOKE_BODY_FIELDS);
  if (bad) return bad;
  if (typeof b.exceptionId !== "string" || !EXCEPTION_REF_RE.test(b.exceptionId)) return invalid("invalid_exception_id", "exceptionId is required (the Exception ID returned when the exception was created)");
  const reason = checkReason(b.reason, "reason");
  if (!reason.ok) return reason;
  return { ok: true, value: { exceptionRef: b.exceptionId, reason: reason.value } };
}

/** The serialisation key for create/revoke on one case: tenant (profile organisation id) + Case Key (whose first segment is the rule key). */
export function exceptionLockKey(profileOrganisationId: string, caseKey: string): string {
  return `${profileOrganisationId}|${caseKey}`;
}

/** Exception IDs are unique per create: UTC timestamp + the first 8 hex chars of the lock token this request owns. */
export function buildExceptionId(now: Date, lockToken: string): string {
  const ts = now.toISOString().replace(/\D/g, "").slice(0, 14);
  const suffix = lockToken.replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase();
  return `NAEX-${ts}-${suffix}`;
}

/** Typed context links from the REAL case's targetIds (never from the request). Only well-formed record ids are written. */
export interface ContextLinks {
  sessionId: string | null;
  occurrenceId: string | null;
  coachId: string | null;
  playerId: string | null;
}
export function contextLinksFromCase(c: NeedsAttentionCase): ContextLinks {
  const pick = (k: string) => (typeof c.targetIds[k] === "string" && RECORD_ID_RE.test(c.targetIds[k]) ? c.targetIds[k] : null);
  return { sessionId: pick("sessionId"), occurrenceId: pick("occurrenceId"), coachId: pick("coachId"), playerId: pick("playerId") };
}

/**
 * An exception row counts as currently in force for this organisation +
 * Case Key when it is Active and not expired - regardless of which rule it
 * links. Used as a belt-and-braces duplicate guard on top of the engine's
 * own suppression match.
 */
export function inForceFor(rows: ExceptionRow[], organisationRecordId: string, caseKey: string, now: Date): ExceptionRow[] {
  return rows.filter((e) => {
    if (!e.active || e.caseKey !== caseKey || !e.organisationIds.includes(organisationRecordId)) return false;
    if (e.effectiveUntil == null) return true;
    const t = Date.parse(e.effectiveUntil);
    return !Number.isNaN(t) && t > now.getTime();
  });
}

export type CreateDecision =
  | { kind: "ok"; entry: PlanEntry; case: NeedsAttentionCase }
  | { kind: "rejected"; httpStatus: 403 | 404 | 409; code: string; error: string; existing?: ExceptionRow };

/**
 * Decide a create from a fresh evaluation of the case's rule (the caller's
 * organisation only). Order: the rule must have been evaluated -> the case
 * must exist now (active or already suppressed) -> not already excepted ->
 * the rule must Support Override -> the organisation must Allow Override.
 */
export function decideCreate(input: {
  caseKey: string;
  ruleKey: string;
  entry: PlanEntry | null;
  complete: boolean;
  active: readonly NeedsAttentionCase[];
  suppressed: readonly SuppressedCase[];
  inForce: readonly ExceptionRow[];
}): CreateDecision {
  const { caseKey, ruleKey, entry } = input;
  if (!entry) return { kind: "rejected", httpStatus: 404, code: "case_not_found", error: `No catalogue rule "${ruleKey}" - there is no such case` };
  if (!entry.run) {
    return { kind: "rejected", httpStatus: 404, code: "case_not_found", error: `Rule ${ruleKey} is not being evaluated (${entry.skipReason ?? "skipped"}), so this case does not currently exist` };
  }
  const sup = input.suppressed.find((s) => s.case.caseKey === caseKey) ?? null;
  const existing = input.inForce[0] ?? null;
  if (sup || existing) {
    return {
      kind: "rejected",
      httpStatus: 409,
      code: "exception_exists",
      error: "This case already has an exception in force - no duplicate was created",
      existing: existing ?? undefined,
    };
  }
  const found = input.active.find((c) => c.caseKey === caseKey) ?? null;
  if (!found) {
    if (!input.complete) return { kind: "rejected", httpStatus: 409, code: "evaluation_incomplete", error: "The rule could not be fully evaluated just now, so the case cannot be confirmed - try again" };
    return { kind: "rejected", httpStatus: 404, code: "case_not_found", error: "This case does not currently exist (it may already have been resolved at source)" };
  }
  if (!entry.rule.supportsOverride) {
    return { kind: "rejected", httpStatus: 403, code: "override_not_supported", error: `Rule ${ruleKey} (${entry.rule.ruleId ?? "?"}) does not support exceptions` };
  }
  if (!entry.config.overrideAllowed) {
    return { kind: "rejected", httpStatus: 403, code: "override_disabled_by_settings", error: `Exceptions for ${ruleKey} are switched off in this organisation's Needs Attention Settings` };
  }
  return { kind: "ok", entry, case: found };
}

/** Storage-neutral create payload (logical field names = the Exceptions table's field names). */
export function buildCreateFields(input: {
  exceptionId: string;
  organisationRecordId: string;
  ruleRecordId: string;
  caseKey: string;
  links: ContextLinks;
  reason: string;
  approver: Actor;
  now: Date;
  effectiveUntil: string | null;
}): Record<string, unknown> {
  const f: Record<string, unknown> = {
    "Exception ID": input.exceptionId,
    Organisation: [input.organisationRecordId],
    Rule: [input.ruleRecordId],
    "Case Key": input.caseKey,
    Reason: input.reason,
    "Approved By User ID": input.approver.userId,
    "Approved By Name Snapshot": input.approver.name,
    "Approved At": input.now.toISOString(),
    Active: true,
  };
  if (input.effectiveUntil) f["Effective Until"] = input.effectiveUntil;
  if (input.links.sessionId) f.Session = [input.links.sessionId];
  if (input.links.occurrenceId) f["Session Occurrence"] = [input.links.occurrenceId];
  if (input.links.coachId) f.Coach = [input.links.coachId];
  if (input.links.playerId) f.Player = [input.links.playerId];
  return f;
}

/** Revoke touches ONLY Active + the four revoke audit fields. The approval snapshot is never rewritten. */
export function buildRevokeFields(input: { revoker: Actor; now: Date; reason: string }): Record<string, unknown> {
  return {
    Active: false,
    "Revoked At": input.now.toISOString(),
    "Revoked By User ID": input.revoker.userId,
    "Revoked By Name Snapshot": input.revoker.name,
    "Revoke Reason": input.reason,
  };
}

/** Find the organisation-owned exception by Exception ID or record id. Rows linked to any other / several organisations are invisible. */
export function findOwnedException(rows: ExceptionRow[], organisationRecordId: string, ref: string): ExceptionRow | null {
  const owned = rows.filter((e) => e.organisationIds.length === 1 && e.organisationIds[0] === organisationRecordId);
  return owned.find((e) => e.recordId === ref) ?? owned.find((e) => e.exceptionId === ref) ?? null;
}

/** API view of an exception - no user ids beyond the approver/revoker id already required for audit; no case payload. */
export function exceptionView(e: ExceptionRow, extra: { ruleKey?: string | null; organisationId?: string } = {}) {
  return {
    exceptionId: e.exceptionId,
    exceptionRecordId: e.recordId,
    caseKey: e.caseKey,
    ruleKey: extra.ruleKey ?? (e.caseKey ? parseCaseKey(e.caseKey)?.ruleKey ?? null : null),
    organisation: extra.organisationId ?? null,
    reason: e.reason,
    approvedBy: { userId: e.approvedByUserId, name: e.approvedByName },
    approvedAt: e.approvedAt,
    effectiveUntil: e.effectiveUntil,
    active: e.active,
    revoked: e.revokedAt ? { at: e.revokedAt, by: { userId: e.revokedByUserId, name: e.revokedByName }, reason: e.revokeReason } : null,
  };
}
