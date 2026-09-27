/**
 * Staffing resolution for Coaches Slice 9 cover (see TEST-ENV.md).
 *
 * The block between the two COPIED markers below is extracted VERBATIM
 * (line ranges, not retyped) from hub-content/player-access.ts - the
 * Slice 2 date rule (sessionStaffAppliesOnDate) and the Slice 3
 * Occurrence Staff merge (resolveOccurrenceStaffing, valid-row rule, role
 * precedence). Per this codebase's "each Edge Function is self-contained"
 * convention it is copied, not imported; tests/support/coach-cover.test.ts
 * asserts every copied block still appears byte-for-byte in
 * player-access.ts, so the two can never silently drift apart.
 */

// ===== COPIED FROM hub-content/player-access.ts - DO NOT EDIT HERE =====
export function firstLink(fields: Record<string, any>, name: string): string {
  const list = fields[name];
  return Array.isArray(list) && list.length ? list[0] : "";
}

const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function sessionStaffAppliesOnDate(row: { fields: Record<string, any> }, dateIso: string): boolean {
  if (row.fields["Active"] !== true) return false;
  const from = row.fields["Effective From"];
  if (from != null && from !== "") {
    if (typeof from !== "string" || !ISO_DATE_ONLY_RE.test(from)) return false;
    if (dateIso < from) return false;
  }
  const until = row.fields["Effective Until"];
  if (until != null && until !== "") {
    if (typeof until !== "string" || !ISO_DATE_ONLY_RE.test(until)) return false;
    if (dateIso > until) return false;
  }
  return true;
}

export function selectName(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return v.name || "";
}

export interface CoachRoleCapabilities {
  active: boolean;
  /** Coach Roles' own "Role Name" (singleLineText, display wording only - e.g. "Lead Coach"). Never matched against for access control; see roleKey. */
  roleName: string;
  /** Coach Roles' own "Role Key" (singleLineText, e.g. "lead_coach") - the STABLE identifier this file gates access on, so renaming a role's display "Role Name" in Airtable can never silently change who has player access. */
  roleKey: string;
  canViewPlayers: boolean;
  canAddFeedback: boolean;
  canEditDevelopmentPlans: boolean;
  canRecordAttendance: boolean;
}

export function roleCapabilitiesById(coachRoleRows: any[]): Record<string, CoachRoleCapabilities> {
  const map: Record<string, CoachRoleCapabilities> = {};
  for (const r of coachRoleRows) {
    map[r.id] = {
      active: r.fields["Active"] === true,
      roleName: String(r.fields["Role Name"] || ""),
      roleKey: String(r.fields["Role Key"] || ""),
      canViewPlayers: r.fields["Can View Players"] === true,
      canAddFeedback: r.fields["Can Add Feedback"] === true,
      canEditDevelopmentPlans: r.fields["Can Edit Development Plans"] === true,
      canRecordAttendance: r.fields["Can Record Attendance"] === true,
    };
  }
  return map;
}

export function roleCapsByRoleName(coachRoleRows: any[]): Record<string, CoachRoleCapabilities> {
  const map: Record<string, CoachRoleCapabilities> = {};
  for (const r of coachRoleRows) {
    const name = String(r.fields["Role Name"] || "");
    if (!name) continue;
    map[name] = {
      active: r.fields["Active"] === true,
      roleName: name,
      roleKey: String(r.fields["Role Key"] || ""),
      canViewPlayers: r.fields["Can View Players"] === true,
      canAddFeedback: r.fields["Can Add Feedback"] === true,
      canEditDevelopmentPlans: r.fields["Can Edit Development Plans"] === true,
      canRecordAttendance: r.fields["Can Record Attendance"] === true,
    };
  }
  return map;
}

function isUsableOccurrenceStaffRow(row: { fields: Record<string, any> }): boolean {
  if (!firstLink(row.fields, "Coach")) return false;
  if (selectName(row.fields["Attendance"]) === "Absent") return false;
  return true;
}

function resolveOccurrenceRoleCaps(
  row: { fields: Record<string, any> },
  sourceRow: any | null,
  roleCapsByName: Record<string, CoachRoleCapabilities>,
  roleCapsById: Record<string, CoachRoleCapabilities>
): CoachRoleCapabilities | null {
  const actual = String(row.fields["Actual Role Snapshot"] || "").trim();
  if (actual) return roleCapsByName[actual] ?? null;
  const planned = String(row.fields["Planned Role Snapshot"] || "").trim();
  if (planned) return roleCapsByName[planned] ?? null;
  if (sourceRow) {
    const roleId = firstLink(sourceRow.fields, "Role");
    if (roleId) return roleCapsById[roleId] ?? null;
  }
  return null;
}

export interface ResolvedOccurrenceCoach {
  coachId: string;
  roleCaps: CoachRoleCapabilities | null;
  /** True when this coach's entry came from (or was role-overridden by) an Occurrence Staff row, rather than being pure Session Staff. */
  fromOccurrenceStaff: boolean;
}

export function resolveOccurrenceStaffing(
  dateIso: string,
  sessionStaffRowsForSession: any[],
  occurrenceStaffRowsForOccurrence: any[],
  roleCapsById: Record<string, CoachRoleCapabilities>,
  roleCapsByNameMap: Record<string, CoachRoleCapabilities>,
  sessionStaffById: Record<string, any>
): ResolvedOccurrenceCoach[] {
  const roster = new Map<string, ResolvedOccurrenceCoach>();

  for (const row of sessionStaffRowsForSession) {
    if (!sessionStaffAppliesOnDate(row, dateIso)) continue;
    const coachId = firstLink(row.fields, "Coach");
    if (!coachId) continue;
    const roleId = firstLink(row.fields, "Role");
    const caps = roleId ? roleCapsById[roleId] ?? null : null;
    roster.set(coachId, { coachId, roleCaps: caps, fromOccurrenceStaff: false });
  }

  for (const row of occurrenceStaffRowsForOccurrence) {
    if (!isUsableOccurrenceStaffRow(row)) continue;
    const coachId = firstLink(row.fields, "Coach");
    if (!coachId) continue;

    const assignmentType = selectName(row.fields["Assignment Type"]);
    const sourceId = firstLink(row.fields, "Session Staff Source");
    const sourceRow = sourceId ? sessionStaffById[sourceId] ?? null : null;

    if (assignmentType === "Cover" && sourceRow) {
      const sourceCoachId = firstLink(sourceRow.fields, "Coach");
      if (sourceCoachId && sourceCoachId !== coachId) roster.delete(sourceCoachId);
    }

    const caps = resolveOccurrenceRoleCaps(row, sourceRow, roleCapsByNameMap, roleCapsById);
    roster.set(coachId, { coachId, roleCaps: caps, fromOccurrenceStaff: true });
  }

  return [...roster.values()];
}
// ===== END COPIED BLOCK =====

// ---------------------------------------------------------------------
// Cover-specific helpers (Slice 9). Everything below is built ON the
// copied resolver above - it never re-implements who is on a roster.
// ---------------------------------------------------------------------

/** Role strength by the STABLE Role Key (never the renameable Role Name). Learning Coach < Coach < Lead Coach. */
export const ROLE_RANK: Record<string, number> = { learning_coach: 1, coach: 2, lead_coach: 3 };

export function roleRank(caps: CoachRoleCapabilities | null): number | null {
  if (!caps || !caps.active) return null;
  return Object.prototype.hasOwnProperty.call(ROLE_RANK, caps.roleKey) ? ROLE_RANK[caps.roleKey] : null;
}

export interface StaffingContext {
  sessionStaffRows: any[];
  occurrenceStaffRows: any[];
  roleCapsById: Record<string, CoachRoleCapabilities>;
  roleCapsByNameMap: Record<string, CoachRoleCapabilities>;
  sessionStaffById: Record<string, any>;
}

export function buildStaffingContext(sessionStaffRows: any[], occurrenceStaffRows: any[], coachRoleRows: any[]): StaffingContext {
  const sessionStaffById: Record<string, any> = {};
  for (const r of sessionStaffRows) sessionStaffById[r.id] = r;
  return {
    sessionStaffRows,
    occurrenceStaffRows,
    roleCapsById: roleCapabilitiesById(coachRoleRows),
    roleCapsByNameMap: roleCapsByRoleName(coachRoleRows),
    sessionStaffById,
  };
}

export interface OccurrenceRef {
  id: string;
  sessionId: string;
  dateIso: string;
}

function sessionStaffForSession(ctx: StaffingContext, sessionId: string): any[] {
  return ctx.sessionStaffRows.filter((r) => firstLink(r.fields, "Session") === sessionId);
}

export function occurrenceStaffForOccurrence(ctx: StaffingContext, occurrenceId: string): any[] {
  return ctx.occurrenceStaffRows.filter((r) => firstLink(r.fields, "Session Occurrence") === occurrenceId);
}

/** Who actually staffs this one occurrence - the Slice 3 resolver, unchanged. */
export function rosterForOccurrence(ctx: StaffingContext, occ: OccurrenceRef, occurrenceStaffOverride?: any[]): ResolvedOccurrenceCoach[] {
  return resolveOccurrenceStaffing(
    occ.dateIso,
    sessionStaffForSession(ctx, occ.sessionId),
    occurrenceStaffOverride ?? occurrenceStaffForOccurrence(ctx, occ.id),
    ctx.roleCapsById,
    ctx.roleCapsByNameMap,
    ctx.sessionStaffById
  );
}

export interface RequesterAssignment {
  /** The requester's own role on this occurrence, as the resolver sees it. */
  roleCaps: CoachRoleCapabilities | null;
  /** Session Staff row to cite as the Cover row's Session Staff Source (so the Slice 3 Cover rule removes the requester). */
  sessionStaffSourceId: string | null;
  /** The requester's own usable Occurrence Staff rows on this occurrence - neutralised (Attendance = Absent) on selection. */
  requesterOccurrenceStaffIds: string[];
}

/**
 * Is `coachId` genuinely staffing this occurrence (via Session Staff or
 * current Occurrence Staff truth), and what exactly would a replacement
 * have to cancel out? null = not assigned to it at all.
 */
export function resolveRequesterAssignment(ctx: StaffingContext, occ: OccurrenceRef, coachId: string): RequesterAssignment | null {
  const entry = rosterForOccurrence(ctx, occ).find((r) => r.coachId === coachId);
  if (!entry) return null;
  const ownSessionStaff = sessionStaffForSession(ctx, occ.sessionId).find(
    (r) => firstLink(r.fields, "Coach") === coachId && sessionStaffAppliesOnDate(r, occ.dateIso)
  );
  const ownOccurrenceRows = occurrenceStaffForOccurrence(ctx, occ.id).filter(
    (r) => isUsableOccurrenceStaffRow(r) && firstLink(r.fields, "Coach") === coachId
  );
  let sourceId: string | null = ownSessionStaff ? ownSessionStaff.id : null;
  if (!sourceId) {
    for (const r of ownOccurrenceRows) {
      const s = firstLink(r.fields, "Session Staff Source");
      if (s && ctx.sessionStaffById[s]) {
        sourceId = s;
        break;
      }
    }
  }
  return { roleCaps: entry.roleCaps, sessionStaffSourceId: sourceId, requesterOccurrenceStaffIds: ownOccurrenceRows.map((r) => r.id) };
}

/**
 * The strongest role this coach currently holds anywhere (any session),
 * from Session Staff rows that apply on `dateIso`. null = no applicable
 * recurring assignment, so capability is unknown (never assumed).
 */
export function coachRoleCapabilityOnDate(ctx: StaffingContext, coachId: string, dateIso: string): { rank: number; roleName: string } | null {
  let best: { rank: number; roleName: string } | null = null;
  for (const r of ctx.sessionStaffRows) {
    if (firstLink(r.fields, "Coach") !== coachId || !sessionStaffAppliesOnDate(r, dateIso)) continue;
    const roleId = firstLink(r.fields, "Role");
    const caps = roleId ? ctx.roleCapsById[roleId] ?? null : null;
    const rank = roleRank(caps);
    if (rank != null && (!best || rank > best.rank)) best = { rank, roleName: caps!.roleName };
  }
  return best;
}

export interface TimedOccurrence extends OccurrenceRef {
  /** Epoch ms, or null when the occurrence has no usable Start/End Date & Time. */
  startMs: number | null;
  endMs: number | null;
  status: string;
}

/**
 * Other occurrences on the same UK date whose time overlaps `target`
 * (half-open intervals) and on whose resolved roster `coachId` already
 * appears (`clashes`). A same-date occurrence the coach staffs but whose
 * times are unusable cannot be ruled out, so it is reported as
 * `uncertain` rather than silently ignored. Returns null when `target`
 * itself has no usable times. Cancelled/Postponed occurrences are not
 * commitments.
 */
export function overlappingAssignments(
  ctx: StaffingContext,
  coachId: string,
  target: TimedOccurrence,
  others: TimedOccurrence[]
): { clashes: TimedOccurrence[]; uncertain: TimedOccurrence[] } | null {
  if (target.startMs == null || target.endMs == null) return null;
  const clashes: TimedOccurrence[] = [];
  const uncertain: TimedOccurrence[] = [];
  for (const o of others) {
    if (o.id === target.id || o.status === "Cancelled" || o.status === "Postponed") continue;
    if (o.dateIso !== target.dateIso) continue;
    const staffed = rosterForOccurrence(ctx, o).some((r) => r.coachId === coachId);
    if (!staffed) continue;
    if (o.startMs == null || o.endMs == null) uncertain.push(o);
    else if (o.startMs < target.endMs && target.startMs < o.endMs) clashes.push(o);
  }
  return { clashes, uncertain };
}
