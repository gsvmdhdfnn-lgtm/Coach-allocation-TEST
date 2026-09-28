// Coach display resolution, as its own copy of what is now in
// functions-test/parent-hub/index.ts (same duplication convention as
// next-occurrence.test.ts and player-access.ts).
//
// Agreed behaviour:
//  - Coaches shown to parents come from Session Staff (Session <-> Coach
//    <-> Role), never the retired free-text schedule field.
//  - Coaches Slice 2: a row counts only when it APPLIES ON THE GIVEN DATE
//    (sessionStaffAppliesOnDate() - Active + Effective From/Until, both
//    inclusive), never "any Active row regardless of date". This is the
//    exact rule hub-content/player-access.ts uses for player-data access -
//    duplicated identically here, never re-derived.
//  - Lead Coach, Coach and Learning Coach are ALL shown - there is no
//    product rule hiding Learning Coach from parents.
//  - Display order: Lead Coach, then Coach, then Learning Coach, then
//    anything unrecognised.
//  - A coach linked twice to the same Session dedupes by the Coach's own
//    record id, never by name text (two different coaches can share a name).
//  - An unpresentable coach name (login/email style) is dropped.

function firstLink(fields: Record<string, any>, name: string): string {
  const list = fields[name];
  return Array.isArray(list) && list.length ? list[0] : "";
}

function presentableName(v: any): string {
  const s = String(v || "").trim();
  if (!s) return "";
  if (s.indexOf("@") >= 0) return "";
  if (!/\s/.test(s) && /[._\d]/.test(s)) return "";
  return s;
}

function buildSessionStaffBySessionId(rows: any[]): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  for (const r of rows) {
    const sid = firstLink(r.fields, "Session");
    if (!sid) continue;
    if (!out[sid]) out[sid] = [];
    out[sid].push(r);
  }
  return out;
}

// Coaches Slice 3: exact duplicates of parent-hub/index.ts's own Occurrence
// Staff helpers (see that file's comments for the full rationale).
function buildSessionStaffById(rows: any[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const r of rows) out[r.id] = r;
  return out;
}
function buildOccurrenceStaffByOccurrenceId(rows: any[]): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  for (const r of rows) {
    const occId = firstLink(r.fields, "Session Occurrence");
    if (!occId) continue;
    if (!out[occId]) out[occId] = [];
    out[occId].push(r);
  }
  return out;
}
function selectName(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return v.name || "";
}
function isUsableOccurrenceStaffRow(row: { fields: Record<string, any> }): boolean {
  if (!firstLink(row.fields, "Coach")) return false;
  if (selectName(row.fields["Attendance"]) === "Absent") return false;
  return true;
}
function isAbsentOccurrenceStaffRow(row: { fields: Record<string, any> }): boolean {
  return !!firstLink(row.fields, "Coach") && selectName(row.fields["Attendance"]) === "Absent";
}

const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Exact duplicate of hub-content/player-access.ts's sessionStaffAppliesOnDate()
// and parent-hub/index.ts's own copy of it - see either file's comment for
// the full rule. Must never drift from either.
function sessionStaffAppliesOnDate(row: { fields: Record<string, any> }, dateIso: string): boolean {
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

const ROLE_DISPLAY_PRIORITY: Record<string, number> = { "Lead Coach": 0, "Coach": 1, "Learning Coach": 2 };

// Coaches Slice 3: exact duplicate of parent-hub/index.ts's own
// resolveOccurrenceRoleName()/resolveOccurrenceRoster().
function resolveOccurrenceRoleName(row: { fields: Record<string, any> }, sourceRow: any | null, roleById: Record<string, any>): string {
  const actual = String(row.fields["Actual Role Snapshot"] || "").trim();
  if (actual) return actual;
  const planned = String(row.fields["Planned Role Snapshot"] || "").trim();
  if (planned) return planned;
  if (sourceRow) {
    const roleId = firstLink(sourceRow.fields, "Role");
    if (roleId && roleById[roleId]) return String(roleById[roleId].fields["Role Name"] || "");
  }
  return "";
}
function resolveOccurrenceRoster(
  dateIso: string,
  sessionStaffRowsForSession: any[],
  occurrenceStaffRowsForOccurrence: any[],
  roleById: Record<string, any>,
  sessionStaffById: Record<string, any>
): { coachId: string; roleName: string }[] {
  const roster = new Map<string, string>();
  for (const row of sessionStaffRowsForSession) {
    if (!sessionStaffAppliesOnDate(row, dateIso)) continue;
    const coachId = firstLink(row.fields, "Coach");
    if (!coachId) continue;
    const roleId = firstLink(row.fields, "Role");
    const roleName = roleId && roleById[roleId] ? String(roleById[roleId].fields["Role Name"] || "") : "";
    roster.set(coachId, roleName);
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
    roster.set(coachId, resolveOccurrenceRoleName(row, sourceRow, roleById));
  }
  for (const row of occurrenceStaffRowsForOccurrence) {
    if (isAbsentOccurrenceStaffRow(row)) roster.delete(firstLink(row.fields, "Coach"));
  }
  return [...roster.entries()].map(([coachId, roleName]) => ({ coachId, roleName }));
}

function resolveSessionCoachNames(
  sessionId: string,
  dateIso: string,
  sessionStaffBySessionId: Record<string, any[]>,
  coachById: Record<string, any>,
  roleById: Record<string, any>,
  occurrenceContext?: { occurrenceStaffRows: any[]; sessionStaffById: Record<string, any> } | null
): string[] {
  const sessionStaffRowsForSession = sessionStaffBySessionId[sessionId] || [];
  const roster = occurrenceContext
    ? resolveOccurrenceRoster(dateIso, sessionStaffRowsForSession, occurrenceContext.occurrenceStaffRows, roleById, occurrenceContext.sessionStaffById)
    : sessionStaffRowsForSession
        .filter((r) => sessionStaffAppliesOnDate(r, dateIso))
        .map((row) => {
          const coachId = firstLink(row.fields, "Coach");
          const roleId = firstLink(row.fields, "Role");
          const roleName = roleId && roleById[roleId] ? String(roleById[roleId].fields["Role Name"] || "") : "";
          return { coachId, roleName };
        });

  const seen = new Set<string>();
  const entries: { name: string; priority: number }[] = [];
  for (const { coachId, roleName } of roster) {
    if (!coachId || seen.has(coachId)) continue;
    const coach = coachById[coachId];
    if (!coach) continue;
    const name = presentableName(coach.fields["Coach Name"]);
    if (!name) continue;
    seen.add(coachId);
    const priority = ROLE_DISPLAY_PRIORITY[roleName];
    entries.push({ name, priority: priority === undefined ? 99 : priority });
  }
  entries.sort((a, b) => a.priority - b.priority);
  return entries.map((e) => e.name);
}

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}

const roleById = {
  lead: { fields: { "Role Name": "Lead Coach" } },
  coach: { fields: { "Role Name": "Coach" } },
  learning: { fields: { "Role Name": "Learning Coach" } },
};

const coachById = {
  alex: { fields: { "Coach Name": "Alex Test" } },
  sam: { fields: { "Coach Name": "Sam Sample" } },
  morgan: { fields: { "Coach Name": "Morgan Manager" } },
  loginStyle: { fields: { "Coach Name": "j.smith" } },
  emailStyle: { fields: { "Coach Name": "coach@example.com" } },
  blank: { fields: { "Coach Name": "" } },
};

{
  // Matches TEST-ENV data: Session A has one Active Lead Coach row.
  const staff = buildSessionStaffBySessionId([
    { id: "ss1", fields: { Session: ["sessA"], Coach: ["alex"], Role: ["lead"], Active: true } },
  ]);
  const names = resolveSessionCoachNames("sessA", "2026-09-20", staff, coachById, roleById);
  ck("A real Session Staff row resolves to the coach's actual name", names.length === 1 && names[0] === "Alex Test", JSON.stringify(names));
}
{
  // Matches TEST-ENV data: Session B has one Active Coach row.
  const staff = buildSessionStaffBySessionId([
    { id: "ss2", fields: { Session: ["sessB"], Coach: ["sam"], Role: ["coach"], Active: true } },
  ]);
  const names = resolveSessionCoachNames("sessB", "2026-09-20", staff, coachById, roleById);
  ck("Session B resolves to Sam Sample via the Coach role", names.length === 1 && names[0] === "Sam Sample", JSON.stringify(names));
}
{
  // Role ordering: Coach and Learning Coach rows entered out of order still display Lead first.
  const staff = buildSessionStaffBySessionId([
    { id: "ss3", fields: { Session: ["sessC"], Coach: ["morgan"], Role: ["learning"], Active: true } },
    { id: "ss4", fields: { Session: ["sessC"], Coach: ["sam"], Role: ["coach"], Active: true } },
    { id: "ss5", fields: { Session: ["sessC"], Coach: ["alex"], Role: ["lead"], Active: true } },
  ]);
  const names = resolveSessionCoachNames("sessC", "2026-09-20", staff, coachById, roleById);
  ck("Lead Coach, Coach, Learning Coach display in that priority order regardless of row order",
    names.join(",") === "Alex Test,Sam Sample,Morgan Manager", names.join(","));
}
{
  // Product rule: Learning Coach IS shown to parents - no visibility flag hides it.
  const staff = buildSessionStaffBySessionId([
    { id: "ss6", fields: { Session: ["sessD"], Coach: ["morgan"], Role: ["learning"], Active: true } },
  ]);
  const names = resolveSessionCoachNames("sessD", "2026-09-20", staff, coachById, roleById);
  ck("Learning Coach is included in the parent-facing coach list", names.length === 1 && names[0] === "Morgan Manager");
}
{
  // Dedup by Coach record id, not name text - a duplicate data-entry row collapses to one name.
  const staff = buildSessionStaffBySessionId([
    { id: "ss7", fields: { Session: ["sessE"], Coach: ["alex"], Role: ["lead"], Active: true } },
    { id: "ss8", fields: { Session: ["sessE"], Coach: ["alex"], Role: ["coach"], Active: true } },
  ]);
  const names = resolveSessionCoachNames("sessE", "2026-09-20", staff, coachById, roleById);
  ck("A coach linked twice to the same session dedupes to one name", names.length === 1 && names[0] === "Alex Test", JSON.stringify(names));
}
{
  // Two different coaches sharing a name text must both still appear.
  const dup1 = { fields: { "Coach Name": "Sam Sample" } };
  const dup2 = { fields: { "Coach Name": "Sam Sample" } };
  const byIdWithDupNames = { d1: dup1, d2: dup2 };
  const staff = buildSessionStaffBySessionId([
    { id: "ss9", fields: { Session: ["sessF"], Coach: ["d1"], Role: ["lead"], Active: true } },
    { id: "ss10", fields: { Session: ["sessF"], Coach: ["d2"], Role: ["coach"], Active: true } },
  ]);
  const names = resolveSessionCoachNames("sessF", "2026-09-20", staff, byIdWithDupNames, roleById);
  ck("Two different coach records that happen to share a name both still appear (dedupe is by id, not text)",
    names.length === 2, JSON.stringify(names));
}
{
  // Active:false rows must be excluded entirely.
  const staff = buildSessionStaffBySessionId([
    { id: "ss11", fields: { Session: ["sessG"], Coach: ["alex"], Role: ["lead"], Active: false } },
  ]);
  const names = resolveSessionCoachNames("sessG", "2026-09-20", staff, coachById, roleById);
  ck("An inactive Session Staff row is excluded from the coach list", names.length === 0, JSON.stringify(names));
}
{
  // A coach with no Session Staff link anywhere (Morgan Manager in real TEST data) never appears unprompted.
  const staff = buildSessionStaffBySessionId([]);
  const names = resolveSessionCoachNames("sessH", "2026-09-20", staff, coachById, roleById);
  ck("A session with zero Session Staff rows returns an empty list, not a throw", names.length === 0);
}
{
  // Unpresentable names (login-style / email-style) are dropped defensively, same rule as elsewhere.
  const staff = buildSessionStaffBySessionId([
    { id: "ss12", fields: { Session: ["sessI"], Coach: ["loginStyle"], Role: ["lead"], Active: true } },
    { id: "ss13", fields: { Session: ["sessI"], Coach: ["emailStyle"], Role: ["coach"], Active: true } },
    { id: "ss14", fields: { Session: ["sessI"], Coach: ["blank"], Role: ["learning"], Active: true } },
    { id: "ss15", fields: { Session: ["sessI"], Coach: ["alex"], Role: ["learning"], Active: true } },
  ]);
  const names = resolveSessionCoachNames("sessI", "2026-09-20", staff, coachById, roleById);
  ck("Login-style, email-style, and blank coach names are dropped; a presentable one still comes through",
    names.length === 1 && names[0] === "Alex Test", JSON.stringify(names));
}
{
  // A dangling Coach link (record not in coachById) must degrade, not throw.
  const staff = buildSessionStaffBySessionId([
    { id: "ss16", fields: { Session: ["sessJ"], Coach: ["missing"], Role: ["lead"], Active: true } },
  ]);
  const names = resolveSessionCoachNames("sessJ", "2026-09-20", staff, coachById, roleById);
  ck("A dangling Coach link resolves to an empty list rather than throwing", names.length === 0);
}
{
  // An unrecognised/blank Role still shows the coach, just last in order.
  const staff = buildSessionStaffBySessionId([
    { id: "ss17", fields: { Session: ["sessK"], Coach: ["sam"], Role: [], Active: true } },
    { id: "ss18", fields: { Session: ["sessK"], Coach: ["alex"], Role: ["lead"], Active: true } },
  ]);
  const names = resolveSessionCoachNames("sessK", "2026-09-20", staff, coachById, roleById);
  ck("A coach with no resolvable Role still appears, ordered after named roles",
    names.join(",") === "Alex Test,Sam Sample", names.join(","));
}

// --- Coaches Slice 2, item 12: parent coach display is date-aware, not just Active ---
{
  const coachHandover = {
    danny: { fields: { "Coach Name": "Danny Handover" } },
    tom: { fields: { "Coach Name": "Tom Handover" } },
  };
  const staff = buildSessionStaffBySessionId([
    { id: "ssDanny", fields: { Session: ["sessL"], Coach: ["danny"], Role: ["lead"], Active: true, "Effective From": "2026-09-07", "Effective Until": "2026-09-20" } },
    { id: "ssTom", fields: { Session: ["sessL"], Coach: ["tom"], Role: ["lead"], Active: true, "Effective From": "2026-09-21", "Effective Until": "2026-10-04" } },
  ]);
  const namesOn19 = resolveSessionCoachNames("sessL", "2026-09-19", staff, coachHandover, roleById);
  ck("12a. A date inside Danny's window shows Danny, not Tom", namesOn19.join(",") === "Danny Handover", namesOn19.join(","));
  const namesOn22 = resolveSessionCoachNames("sessL", "2026-09-22", staff, coachHandover, roleById);
  ck("12b. A date inside Tom's window shows Tom, not Danny, even though Danny's row is still Active=true", namesOn22.join(",") === "Tom Handover", namesOn22.join(","));
  const namesOn20 = resolveSessionCoachNames("sessL", "2026-09-20", staff, coachHandover, roleById);
  ck("12c. Danny's own Effective Until boundary is inclusive - still Danny, not both/neither", namesOn20.join(",") === "Danny Handover", namesOn20.join(","));
  const namesOn21 = resolveSessionCoachNames("sessL", "2026-09-21", staff, coachHandover, roleById);
  ck("12d. Tom's own Effective From boundary is inclusive - already Tom", namesOn21.join(",") === "Tom Handover", namesOn21.join(","));
  ck("Do not show both merely because both rows are Active - exactly one coach per non-overlapping date", namesOn19.length === 1 && namesOn22.length === 1);
}
{
  // Active=false suppresses display even when the date falls inside the range.
  const staff = buildSessionStaffBySessionId([
    { id: "ssRetracted", fields: { Session: ["sessM"], Coach: ["alex"], Role: ["lead"], Active: false, "Effective From": "2026-09-07", "Effective Until": "2026-09-20" } },
  ]);
  const names = resolveSessionCoachNames("sessM", "2026-09-14", staff, coachById, roleById);
  ck("A retracted (Active=false) row is never shown, even inside its own date range", names.length === 0, JSON.stringify(names));
}
{
  // Malformed Effective From/Until fails closed for display too, never shown.
  const staff = buildSessionStaffBySessionId([
    { id: "ssBadDate", fields: { Session: ["sessN"], Coach: ["alex"], Role: ["lead"], Active: true, "Effective From": "07/09/2026" } },
  ]);
  const names = resolveSessionCoachNames("sessN", "2026-09-14", staff, coachById, roleById);
  ck("A malformed Effective From excludes the row from display rather than showing it as unbounded", names.length === 0, JSON.stringify(names));
}

// --- Coaches Slice 3, item 9: parent coach display reflects occurrence-specific replacement ---
{
  const coachOS = {
    danny: { fields: { "Coach Name": "Danny Occurrence" } },
    joe: { fields: { "Coach Name": "Joe Occurrence" } },
  };
  const ssDanny = { id: "ssOSDanny", fields: { Session: ["sessOS"], Coach: ["danny"], Role: ["lead"], Active: true } };
  const staff = buildSessionStaffBySessionId([ssDanny]);
  const sessionStaffById = buildSessionStaffById([ssDanny]);

  const coverRow = { id: "osCover", fields: { Coach: ["joe"], "Session Occurrence": ["occCoverDisplay"], "Assignment Type": "Cover", "Session Staff Source": [ssDanny.id], "Actual Role Snapshot": "Lead Coach" } };
  const occurrenceStaffByOcc = buildOccurrenceStaffByOccurrenceId([coverRow]);

  const namesOnCoveredDate = resolveSessionCoachNames("sessOS", "2026-10-10", staff, coachOS, roleById, { occurrenceStaffRows: occurrenceStaffByOcc["occCoverDisplay"] || [], sessionStaffById });
  ck("9a. Covered occurrence shows the covering coach only", namesOnCoveredDate.join(",") === "Joe Occurrence", namesOnCoveredDate.join(","));

  const namesOnOtherDate = resolveSessionCoachNames("sessOS", "2026-10-11", staff, coachOS, roleById, { occurrenceStaffRows: [], sessionStaffById });
  ck("9b. The following occurrence (no Occurrence Staff rows) shows the normal recurring coach again, not Joe", namesOnOtherDate.join(",") === "Danny Occurrence", namesOnOtherDate.join(","));

  const namesNoContext = resolveSessionCoachNames("sessOS", "2026-10-11", staff, coachOS, roleById);
  ck("9c. Omitting occurrenceContext entirely is byte-identical to Slice 2 (recurring coach only)", namesNoContext.join(",") === "Danny Occurrence", namesNoContext.join(","));
}

// --- Coaches Slice 3, item 10: additive parent display returns both valid coaches ---
{
  const coachOS = {
    danny: { fields: { "Coach Name": "Danny Additive" } },
    joe: { fields: { "Coach Name": "Joe Additive" } },
  };
  const ssDanny = { id: "ssAddDanny", fields: { Session: ["sessOS2"], Coach: ["danny"], Role: ["lead"], Active: true } };
  const staff = buildSessionStaffBySessionId([ssDanny]);
  const sessionStaffById = buildSessionStaffById([ssDanny]);

  const additiveRow = { id: "osAdd", fields: { Coach: ["joe"], "Session Occurrence": ["occAddDisplay"], "Assignment Type": "Additional", Attendance: "Planned", "Planned Role Snapshot": "Coach" } };
  const occurrenceStaffByOcc = buildOccurrenceStaffByOccurrenceId([additiveRow]);

  const names = resolveSessionCoachNames("sessOS2", "2026-10-10", staff, coachOS, roleById, { occurrenceStaffRows: occurrenceStaffByOcc["occAddDisplay"] || [], sessionStaffById });
  ck("10. An additive Occurrence Staff row shows BOTH the recurring coach and the added one, Lead Coach first by role priority", names.join(",") === "Danny Additive,Joe Additive", names.join(","));
}

// --- Staffing Absent correction (2026-09-28): parent display drops an absent coach, with or without cover ---
{
  const coachAbs = {
    danny: { fields: { "Coach Name": "Danny Absent" } },
    joe: { fields: { "Coach Name": "Joe Cover" } },
  };
  const ssDanny = { id: "ssAbsDanny", fields: { Session: ["sessAbs"], Coach: ["danny"], Role: ["lead"], Active: true } };
  const staff = buildSessionStaffBySessionId([ssDanny]);
  const sessionStaffById = buildSessionStaffById([ssDanny]);
  const absentRow = { id: "osAbsDanny", fields: { Coach: ["danny"], "Session Occurrence": ["occAbs"], "Assignment Type": "Planned", Attendance: "Absent" } };
  const coverRow = { id: "osAbsCover", fields: { Coach: ["joe"], "Session Occurrence": ["occAbs"], "Assignment Type": "Cover", "Session Staff Source": [ssDanny.id], "Planned Role Snapshot": "Lead Coach" } };
  const noCover = resolveSessionCoachNames("sessAbs", "2026-10-10", staff, coachAbs, roleById, { occurrenceStaffRows: [absentRow], sessionStaffById });
  ck("AB1. Absent recurring coach, no cover: parents are not shown Danny for that occurrence", noCover.length === 0, noCover.join(","));
  const withCover = resolveSessionCoachNames("sessAbs", "2026-10-10", staff, coachAbs, roleById, { occurrenceStaffRows: [absentRow, coverRow], sessionStaffById });
  ck("AB2. Absent + cover: parents see the cover coach only", withCover.join(",") === "Joe Cover", withCover.join(","));
  const otherDate = resolveSessionCoachNames("sessAbs", "2026-10-17", staff, coachAbs, roleById, { occurrenceStaffRows: [], sessionStaffById });
  ck("AB3. Other dates unchanged: Danny shows normally", otherDate.join(",") === "Danny Absent", otherDate.join(","));
}

console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} passing`);
process.exit(failed ? 1 : 0);
