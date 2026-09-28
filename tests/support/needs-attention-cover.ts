/**
 * Test-suite copy of the canonical needs-attention/cover.ts, kept in sync
 * by hand exactly like every other deployed copy. Only import paths adjusted:
 * ./needs-attention|repository|registry|staffing|cover|compliance|exceptions|lock-client.ts become needs-attention-*.ts.
 */
/**
 * Cover evaluator for Needs Attention Slice 4 (see TEST-ENV.md "Needs
 * Attention Foundation - Slice 4"): cover_open - exactly ONE case per cover
 * DATE (one Staff Availability Requests row), replacing production's
 * cover_requested + cover_unresolved pair.
 *
 * Source of truth is the Coaches Slice 9 cover workflow (coach-cover). This
 * file never re-interprets it: a date needs Management attention exactly
 * while its own "Cover Date Status" is Open - the same test the workflow
 * uses before it will accept a response, a selection or a cancellation.
 * Filled / Cancelled / Resolved Without Cover are the workflow's terminal
 * states, so the case disappears on its own when Management resolves the
 * date there. A coach's Accept is only willingness (the workflow never
 * treats it as cover), so it never closes the case. The group status
 * derivation is COPIED VERBATIM from coach-cover/cover-workflow.ts
 * (drift-tested), for the grouping metadata only.
 *
 * Deliberately NOT reused: coach-cover's unfilledSignal() (Open >= 24h
 * since creation). That is the workflow's own legacy list flag; Needs
 * Attention severity is the locked catalogue model instead (Normal ->
 * Warning 48h after the request was created -> Urgent within 24h of the
 * occurrence start), computed by the generic engine from the anchors
 * supplied here.
 *
 * One shared pass per request (memoised), no per-date queries.
 */
import type { AirtableRecord, CandidateCase, ConfigIssue, EvaluatorContext, EvaluatorRegistration } from "./needs-attention-engine.ts";
import { firstLink, formatLocal, localDateIso, selectName } from "./needs-attention-staffing.ts";

// ===== COPIED FROM coach-cover/cover-workflow.ts - DO NOT EDIT HERE =====
export const COVER_DATE_STATUSES = ["Open", "Filled", "Cancelled", "Resolved Without Cover"] as const;

/** Group status is derived from its dates, never trusted from the stored text. */
export function deriveGroupStatus(dateStatuses: string[]): string {
  if (dateStatuses.length === 0) return "Cancelled";
  const open = dateStatuses.includes("Open");
  const filled = dateStatuses.includes("Filled");
  if (open) return filled ? "Partially Filled" : "Open";
  if (filled) return "Filled";
  if (dateStatuses.every((s) => s === "Cancelled")) return "Cancelled";
  return "Resolved Without Cover";
}
// ===== END COPIED BLOCK =====

export const COVER_TABLES = {
  requestDates: "Staff Availability Requests",
  responses: "Cover Responses",
  occurrences: "Session Occurrences",
  sessions: "Sessions",
  coaches: "Coaches",
} as const;
/** Session Occurrences / Sessions / Coaches are shared with the staffing rules, so the engine loads each only once. */
export const COVER_SOURCES: readonly string[] = Object.values(COVER_TABLES);

/** Occurrence Status values that mean the session will not run (catalogue: "not Cancelled/Postponed"). */
const NOT_RUNNING = new Set(["Cancelled", "Postponed"]);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function linkIds(v: any): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x : x?.id)).filter((x): x is string => typeof x === "string");
}

export type CoverSkip = "not_open" | "occurrence_not_running" | "occurrence_started";

/**
 * Is this cover date a live cover_open case right now?
 *  - its own Cover Date Status must be Open (Filled / Cancelled / Resolved
 *    Without Cover = resolved in the workflow; anything else = not open);
 *  - its occurrence must not be Cancelled / Postponed (the session is not
 *    going ahead, so there is nothing to cover);
 *  - its occurrence must not have started (start <= now; date-only:
 *    Date before today in the organisation timezone).
 * A missing occurrence does NOT hide the case (fail visible) - see issues.
 */
export function coverDateEligibility(rd: AirtableRecord, occ: AirtableRecord | null, now: Date, timeZone: string): CoverSkip | null {
  if (selectName(rd.fields["Cover Date Status"]) !== "Open") return "not_open";
  if (!occ) return null;
  if (NOT_RUNNING.has(selectName(occ.fields["Status"]))) return "occurrence_not_running";
  const startRaw = occ.fields["Start Date & Time"];
  const start = typeof startRaw === "string" && startRaw ? Date.parse(startRaw) : NaN;
  if (!Number.isNaN(start)) return start <= now.getTime() ? "occurrence_started" : null;
  const date = occ.fields["Date"];
  if (typeof date === "string" && ISO_DATE_RE.test(date) && date < localDateIso(now, timeZone)) return "occurrence_started";
  return null;
}

export interface CoverDateAnalysis {
  requestDateId: string;
  requestId: string | null;
  groupId: string | null;
  groupStatus: string;
  siblingRequestDateIds: string[];
  siblingOpenCount: number;
  occurrenceId: string | null;
  occurrenceFound: boolean;
  occurrenceName: string | null;
  occurrenceStatus: string | null;
  sessionId: string | null;
  sessionName: string | null;
  dateIso: string | null;
  startIso: string | null;
  endIso: string | null;
  requesterCoachId: string | null;
  requesterName: string | null;
  replacementCoachId: string | null;
  /** The row's own Airtable createdTime - the request-age (Warning) anchor. */
  requestedAt: string | null;
  openForMinutes: number | null;
  acceptedCoachIds: string[];
  declinedCount: number;
}

export interface CoverPass {
  analyses: CoverDateAnalysis[];
  skipped: Record<string, number>;
  issues: ConfigIssue[];
}

export const coverPassStats = { passes: 0 };

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

export function runCoverPass(sources: Readonly<Record<string, readonly AirtableRecord[]>>, now: Date, timeZone: string): CoverPass {
  coverPassStats.passes++;
  const T = COVER_TABLES;
  const dates = sources[T.requestDates] ?? [];
  const occById = new Map((sources[T.occurrences] ?? []).map((o) => [o.id, o]));
  const sessionById = new Map((sources[T.sessions] ?? []).map((s) => [s.id, s]));
  const coachById = new Map((sources[T.coaches] ?? []).map((c) => [c.id, c]));
  const byGroup = new Map<string, AirtableRecord[]>();
  for (const rd of dates) {
    const g = firstLink(rd.fields, "Cover Request Group");
    if (g) byGroup.set(g, [...(byGroup.get(g) ?? []), rd]);
  }
  const responsesByDate = new Map<string, AirtableRecord[]>();
  for (const r of sources[T.responses] ?? []) {
    if (r.fields["Active"] !== true) continue;
    for (const d of linkIds(r.fields["Cover Request Date"])) responsesByDate.set(d, [...(responsesByDate.get(d) ?? []), r]);
  }

  const analyses: CoverDateAnalysis[] = [];
  const skipped: Record<string, number> = {};
  const issues: ConfigIssue[] = [];
  for (const rd of dates) {
    const occId = firstLink(rd.fields, "Session Occurrence") || null;
    const occ = occId ? occById.get(occId) ?? null : null;
    const why = coverDateEligibility(rd, occ, now, timeZone);
    if (why) {
      skipped[why] = (skipped[why] ?? 0) + 1;
      continue;
    }
    const session = occ ? sessionById.get(firstLink(occ.fields, "Session")) ?? null : null;
    const groupId = firstLink(rd.fields, "Cover Request Group") || null;
    const siblings = groupId ? byGroup.get(groupId) ?? [rd] : [rd];
    const requesterId = firstLink(rd.fields, "Coach") || null;
    const responses = responsesByDate.get(rd.id) ?? [];
    const created = rd.createdTime ? Date.parse(rd.createdTime) : NaN;
    const a: CoverDateAnalysis = {
      requestDateId: rd.id,
      requestId: str(rd.fields["Request ID"]),
      groupId,
      groupStatus: deriveGroupStatus(siblings.map((s) => selectName(s.fields["Cover Date Status"]))),
      siblingRequestDateIds: siblings.map((s) => s.id).filter((id) => id !== rd.id),
      siblingOpenCount: siblings.filter((s) => s.id !== rd.id && selectName(s.fields["Cover Date Status"]) === "Open").length,
      occurrenceId: occId,
      occurrenceFound: !!occ,
      occurrenceName: occ ? str(occ.fields["Occurrence Name"]) : null,
      occurrenceStatus: occ ? selectName(occ.fields["Status"]) || null : null,
      sessionId: session?.id ?? null,
      sessionName: session ? str(session.fields["Session Name"]) : null,
      dateIso: occ ? str(occ.fields["Date"]) : null,
      startIso: occ ? str(occ.fields["Start Date & Time"]) : null,
      endIso: occ ? str(occ.fields["End Date & Time"]) : null,
      requesterCoachId: requesterId,
      requesterName: requesterId ? str(coachById.get(requesterId)?.fields["Coach Name"]) : null,
      replacementCoachId: firstLink(rd.fields, "Replacement Coach") || null,
      requestedAt: rd.createdTime ?? null,
      // Airtable createdTime is whole-second and from Airtable's clock: clamp a fractionally-future value to 0.
      openForMinutes: Number.isNaN(created) ? null : Math.floor(Math.max(0, now.getTime() - created) / 60000),
      acceptedCoachIds: responses.filter((r) => selectName(r.fields["Response Status"]) === "Yes").map((r) => firstLink(r.fields, "Coach")).filter(Boolean),
      declinedCount: responses.filter((r) => selectName(r.fields["Response Status"]) === "No").length,
    };
    analyses.push(a);
    if (!occ) {
      issues.push({ code: "cover_occurrence_missing", recordId: rd.id, detail: `Open cover date ${rd.id} links no readable Session Occurrence (${occId ?? "none"}). The case is still shown, but it cannot escalate on session time.` });
    } else if (!a.startIso) {
      issues.push({ code: "cover_occurrence_untimed", recordId: rd.id, detail: `Open cover date ${rd.id}: occurrence ${occ.id} has no Start Date & Time, so the 24h-before-session Urgent escalation cannot apply.` });
    }
    if (!a.requestedAt) {
      issues.push({ code: "cover_request_time_unknown", recordId: rd.id, detail: `Open cover date ${rd.id} has no created time, so the 48h unresolved Warning escalation cannot apply.` });
    }
  }
  return { analyses, skipped, issues };
}

const passCache = new WeakMap<object, { key: string; pass: CoverPass }>();

/** One shared cover pass per request (memoised on the loaded request-dates array identity). */
export function sharedCoverPass(ctx: EvaluatorContext): CoverPass {
  const dates = ctx.sources[COVER_TABLES.requestDates] ?? [];
  const key = `${ctx.now.getTime()}|${ctx.organisation.timezone}|${COVER_SOURCES.map((t) => (ctx.sources[t] ?? []).length).join(",")}`;
  const hit = passCache.get(dates);
  if (hit && hit.key === key) return hit.pass;
  const pass = runCoverPass(ctx.sources, ctx.now, ctx.organisation.timezone);
  passCache.set(dates, { key, pass });
  return pass;
}

function ageText(minutes: number | null): string {
  if (minutes == null) return "at an unknown time";
  if (minutes < 60) return `${minutes} min ago`;
  const h = Math.floor(minutes / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ${h % 24}h ago`;
}

export function coverCase(a: CoverDateAnalysis, timeZone: string): CandidateCase {
  const when = formatLocal(a.startIso, a.dateIso, timeZone);
  const who = a.requesterName ?? "A coach";
  const accepted = a.acceptedCoachIds.length;
  const responsesText = accepted
    ? `${accepted} coach${accepted === 1 ? "" : "es"} accepted - choose the cover coach.`
    : `No coach has accepted yet${a.declinedCount ? ` (${a.declinedCount} declined)` : ""}.`;
  const siblingText = a.siblingRequestDateIds.length ? ` Part of a ${a.siblingRequestDateIds.length + 1}-date request (${a.siblingOpenCount} other date${a.siblingOpenCount === 1 ? "" : "s"} still open).` : "";
  const params: Record<string, string> = { requestDateId: a.requestDateId };
  if (a.groupId) params.groupId = a.groupId;
  if (a.occurrenceId) params.occurrenceId = a.occurrenceId;
  const targetIds: Record<string, string> = { requestDateId: a.requestDateId };
  if (a.occurrenceId) targetIds.occurrenceId = a.occurrenceId;
  if (a.sessionId) targetIds.sessionId = a.sessionId;
  if (a.groupId) targetIds.coverRequestGroupId = a.groupId;
  return {
    subjects: [{ type: "coverdate", id: a.requestDateId }],
    title: `Cover needed - ${a.sessionName ?? a.occurrenceName ?? "session"}`,
    detail: `${when} - ${who} requested cover ${ageText(a.openForMinutes)}; not yet filled. ${responsesText}${siblingText}`,
    anchors: { event: a.startIso, outstandingSince: a.requestedAt },
    anchorTime: a.startIso ?? a.dateIso,
    destination: { route: "coaches/cover-request-date", params },
    targetIds,
    relatedIds: {
      requesterCoachIds: a.requesterCoachId ? [a.requesterCoachId] : [],
      acceptedCoachIds: a.acceptedCoachIds,
      siblingRequestDateIds: a.siblingRequestDateIds,
    },
    context: {
      coverDateStatus: "Open",
      requestId: a.requestId,
      coverRequestGroupId: a.groupId,
      groupStatus: a.groupStatus,
      siblingDates: a.siblingRequestDateIds.length,
      siblingOpenDates: a.siblingOpenCount,
      requesterCoachId: a.requesterCoachId,
      requesterName: a.requesterName,
      requestedAt: a.requestedAt,
      openForMinutes: a.openForMinutes,
      openForHours: a.openForMinutes == null ? null : Math.floor(a.openForMinutes / 60),
      acceptedResponses: accepted,
      declinedResponses: a.declinedCount,
      selectedCoachId: null,
      occurrenceId: a.occurrenceId,
      occurrenceName: a.occurrenceName,
      occurrenceStatus: a.occurrenceStatus,
      sessionId: a.sessionId,
      sessionName: a.sessionName,
      date: a.dateIso,
      start: a.startIso,
      end: a.endIso,
      startLocal: when,
    },
  };
}

export const COVER_EVALUATOR: EvaluatorRegistration = {
  ruleKey: "cover_open",
  ruleId: "ATT-041",
  sources: COVER_SOURCES,
  evaluate(ctx: EvaluatorContext): CandidateCase[] {
    const pass = sharedCoverPass(ctx);
    for (const issue of pass.issues) ctx.reportIssue?.(issue);
    return pass.analyses.map((a) => coverCase(a, ctx.organisation.timezone));
  },
};
