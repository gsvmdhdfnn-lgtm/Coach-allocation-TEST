// Coach display resolution, as its own copy of what is now in
// functions-test/parent-hub/index.ts (same duplication convention as
// next-occurrence.test.ts and player-access.ts).
//
// Agreed behaviour:
//  - Coaches shown to parents come from Session Staff (Session <-> Coach
//    <-> Role), never the retired free-text schedule field.
//  - Only Active:true Session Staff rows count.
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

const ROLE_DISPLAY_PRIORITY: Record<string, number> = { "Lead Coach": 0, "Coach": 1, "Learning Coach": 2 };

function resolveSessionCoachNames(
  sessionId: string,
  sessionStaffBySessionId: Record<string, any[]>,
  coachById: Record<string, any>,
  roleById: Record<string, any>
): string[] {
  const rows = (sessionStaffBySessionId[sessionId] || []).filter((r) => r.fields["Active"] === true);
  const seen = new Set<string>();
  const entries: { name: string; priority: number }[] = [];
  for (const row of rows) {
    const coachId = firstLink(row.fields, "Coach");
    if (!coachId || seen.has(coachId)) continue;
    const coach = coachById[coachId];
    if (!coach) continue;
    const name = presentableName(coach.fields["Coach Name"]);
    if (!name) continue;
    seen.add(coachId);
    const roleId = firstLink(row.fields, "Role");
    const roleName = roleId && roleById[roleId] ? String(roleById[roleId].fields["Role Name"] || "") : "";
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
  const names = resolveSessionCoachNames("sessA", staff, coachById, roleById);
  ck("A real Session Staff row resolves to the coach's actual name", names.length === 1 && names[0] === "Alex Test", JSON.stringify(names));
}
{
  // Matches TEST-ENV data: Session B has one Active Coach row.
  const staff = buildSessionStaffBySessionId([
    { id: "ss2", fields: { Session: ["sessB"], Coach: ["sam"], Role: ["coach"], Active: true } },
  ]);
  const names = resolveSessionCoachNames("sessB", staff, coachById, roleById);
  ck("Session B resolves to Sam Sample via the Coach role", names.length === 1 && names[0] === "Sam Sample", JSON.stringify(names));
}
{
  // Role ordering: Coach and Learning Coach rows entered out of order still display Lead first.
  const staff = buildSessionStaffBySessionId([
    { id: "ss3", fields: { Session: ["sessC"], Coach: ["morgan"], Role: ["learning"], Active: true } },
    { id: "ss4", fields: { Session: ["sessC"], Coach: ["sam"], Role: ["coach"], Active: true } },
    { id: "ss5", fields: { Session: ["sessC"], Coach: ["alex"], Role: ["lead"], Active: true } },
  ]);
  const names = resolveSessionCoachNames("sessC", staff, coachById, roleById);
  ck("Lead Coach, Coach, Learning Coach display in that priority order regardless of row order",
    names.join(",") === "Alex Test,Sam Sample,Morgan Manager", names.join(","));
}
{
  // Product rule: Learning Coach IS shown to parents - no visibility flag hides it.
  const staff = buildSessionStaffBySessionId([
    { id: "ss6", fields: { Session: ["sessD"], Coach: ["morgan"], Role: ["learning"], Active: true } },
  ]);
  const names = resolveSessionCoachNames("sessD", staff, coachById, roleById);
  ck("Learning Coach is included in the parent-facing coach list", names.length === 1 && names[0] === "Morgan Manager");
}
{
  // Dedup by Coach record id, not name text - a duplicate data-entry row collapses to one name.
  const staff = buildSessionStaffBySessionId([
    { id: "ss7", fields: { Session: ["sessE"], Coach: ["alex"], Role: ["lead"], Active: true } },
    { id: "ss8", fields: { Session: ["sessE"], Coach: ["alex"], Role: ["coach"], Active: true } },
  ]);
  const names = resolveSessionCoachNames("sessE", staff, coachById, roleById);
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
  const names = resolveSessionCoachNames("sessF", staff, byIdWithDupNames, roleById);
  ck("Two different coach records that happen to share a name both still appear (dedupe is by id, not text)",
    names.length === 2, JSON.stringify(names));
}
{
  // Active:false rows must be excluded entirely.
  const staff = buildSessionStaffBySessionId([
    { id: "ss11", fields: { Session: ["sessG"], Coach: ["alex"], Role: ["lead"], Active: false } },
  ]);
  const names = resolveSessionCoachNames("sessG", staff, coachById, roleById);
  ck("An inactive Session Staff row is excluded from the coach list", names.length === 0, JSON.stringify(names));
}
{
  // A coach with no Session Staff link anywhere (Morgan Manager in real TEST data) never appears unprompted.
  const staff = buildSessionStaffBySessionId([]);
  const names = resolveSessionCoachNames("sessH", staff, coachById, roleById);
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
  const names = resolveSessionCoachNames("sessI", staff, coachById, roleById);
  ck("Login-style, email-style, and blank coach names are dropped; a presentable one still comes through",
    names.length === 1 && names[0] === "Alex Test", JSON.stringify(names));
}
{
  // A dangling Coach link (record not in coachById) must degrade, not throw.
  const staff = buildSessionStaffBySessionId([
    { id: "ss16", fields: { Session: ["sessJ"], Coach: ["missing"], Role: ["lead"], Active: true } },
  ]);
  const names = resolveSessionCoachNames("sessJ", staff, coachById, roleById);
  ck("A dangling Coach link resolves to an empty list rather than throwing", names.length === 0);
}
{
  // An unrecognised/blank Role still shows the coach, just last in order.
  const staff = buildSessionStaffBySessionId([
    { id: "ss17", fields: { Session: ["sessK"], Coach: ["sam"], Role: [], Active: true } },
    { id: "ss18", fields: { Session: ["sessK"], Coach: ["alex"], Role: ["lead"], Active: true } },
  ]);
  const names = resolveSessionCoachNames("sessK", staff, coachById, roleById);
  ck("A coach with no resolvable Role still appears, ordered after named roles",
    names.join(",") === "Alex Test,Sam Sample", names.join(","));
}

console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} passing`);
process.exit(failed ? 1 : 0);
