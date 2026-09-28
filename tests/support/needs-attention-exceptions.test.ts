// Unit + integration tests for Needs Attention Slice 5 - the Management
// exception write path (see TEST-ENV.md "Needs Attention Foundation -
// Slice 5"). Request-level behaviour runs through the REAL orchestrator +
// the deployed registry (staffing + cover) against an in-memory Airtable
// that allows exactly two kinds of write - create one row in / patch one
// row of "Needs Attention Exceptions" - and fails the test on anything
// else, plus an in-memory implementation of the lock client.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirtableRecord } from "./needs-attention-engine.ts";
import { matchException, parseException } from "./needs-attention-engine.ts";
import { createException, getCases, revokeException, type Caller, type Deps } from "./needs-attention-orchestrator.ts";
import { IMPLEMENTED_EVALUATORS } from "./needs-attention-registry.ts";
import { CONFIG_TABLES, RETRY_DELAYS_MS } from "./needs-attention-repository.ts";
import { localDateIso } from "./needs-attention-staffing.ts";
import type { LockClient } from "./needs-attention-lock-client.ts";
import {
  EXCEPTION_REASON_MAX,
  actorFromProfile,
  buildExceptionId,
  buildRevokeFields,
  contextLinksFromCase,
  findOwnedException,
  inForceFor,
  parseCreateBody,
  parseRevokeBody,
} from "./needs-attention-exceptions.ts";

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const CANON = join(HERE, "..", "..", "supabase", "functions-test", "needs-attention");

// ---------------------------------------------------------------------
// Fixtures (same shapes as the staffing / cover suites)
// ---------------------------------------------------------------------
const id = (tag: string) => "rec" + (tag + "00000000000000").slice(0, 14);
const ORG = id("OrgTest1"), ORG2 = id("OrgOther");
const NOW = new Date("2026-10-01T10:00:00.000Z");
const H = 3600 * 1000, D = 24 * H;
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const later = (ms: number) => new Date(NOW.getTime() + ms);
const TZ = "Europe/London";

const ROLE_LEAD = id("RoleLead"), ROLE_COACH = id("RoleCoach");
const roles: AirtableRecord[] = [
  { id: ROLE_LEAD, fields: { "Role Name": "Lead Coach", "Role Key": "lead_coach", Active: true } },
  { id: ROLE_COACH, fields: { "Role Name": "Coach", "Role Key": "coach", Active: true } },
];
const C1 = id("CoachOne"), C2 = id("CoachTwo");
const COACHES: AirtableRecord[] = [
  { id: C1, fields: { "Coach Name": "Alex One", Active: true } },
  { id: C2, fields: { "Coach Name": "Sam Two", Active: true } },
];
function session(sid: string, o: { lead?: boolean; rsc?: number | null; name?: string } = {}): AirtableRecord {
  const f: Record<string, any> = { "Session Name": o.name ?? `Session ${sid.slice(3, 8)}`, "Session Lifecycle Status": "Active" };
  if (o.lead) f["Requires Lead Coach"] = true;
  if (o.rsc != null) f["Required Staff Count"] = o.rsc;
  return { id: sid, fields: f };
}
function occ(oid: string, sid: string, startMs: number): AirtableRecord {
  const start = at(startMs);
  return { id: oid, fields: { "Occurrence Name": `Occ ${oid.slice(3, 9)}`, Status: "Scheduled", Session: [sid], Date: localDateIso(new Date(start), TZ), "Start Date & Time": start, "End Date & Time": at(startMs + H) } };
}
let ssN = 0;
function staff(sid: string, coach: string, role: string): AirtableRecord {
  return { id: id("SS" + String(++ssN).padStart(3, "0")), fields: { Session: [sid], Coach: [coach], Role: [role], Active: true } };
}
function rule(key: string, ruleId: string, o: { sev?: string; warn?: [number, string]; urg?: [number, string]; sort: number; override: boolean; area?: string; action?: string }): AirtableRecord {
  const f: Record<string, any> = {
    "Rule Name": key, "Rule ID": ruleId, "Rule Key": key, Category: "Staffing & Cover", "Default Enabled": true, "Default Base Severity": o.sev ?? "Normal",
    "Client Customisable": true, "Required Module": "module_coaches", "Evaluation Status": "Active", "Sort Order": o.sort, Active: true,
    "Action Label": o.action ?? "Review Staffing", "Destination Area": o.area ?? "Schedule & Sessions",
  };
  if (o.override) f["Supports Override"] = true;
  if (o.warn) Object.assign(f, { "Supports Warning Threshold": true, "Default Warning Threshold": o.warn[0], "Default Warning Timing": o.warn[1] });
  if (o.urg) Object.assign(f, { "Supports Urgent Threshold": true, "Default Urgent Threshold": o.urg[0], "Default Urgent Timing": o.urg[1] });
  return { id: id("Rule" + ruleId.replace("-", "")), fields: f };
}
// The TEST catalogue's real values, INCLUDING Supports Override (staffing Yes, cover_open No - NA1.7).
const RULES = [
  rule("no_lead_coach", "ATT-001", { warn: [72, "Hours Before"], urg: [24, "Hours Before"], sort: 1, override: true }),
  rule("learning_coach_only", "ATT-002", { warn: [72, "Hours Before"], urg: [24, "Hours Before"], sort: 2, override: true }),
  rule("session_understaffed", "ATT-005", { warn: [72, "Hours Before"], urg: [24, "Hours Before"], sort: 5, override: true }),
  rule("session_no_coach", "ATT-013", { sev: "Warning", urg: [48, "Hours Before"], sort: 13, override: true, action: "Assign Staff" }),
  rule("cover_open", "ATT-041", { warn: [48, "Hours Overdue"], urg: [24, "Hours Before"], sort: 41, override: false, area: "Coaches", action: "Resolve Cover" }),
];
const NLC_RULE = RULES[0], COVER_RULE = RULES[4];

// ---------------------------------------------------------------------
// In-memory Airtable: GET lists; POST/PATCH allowed ONLY on the Exceptions table.
// ---------------------------------------------------------------------
let tables: Record<string, AirtableRecord[]> = {};
let requests: { method: string; table: string }[] = [];
let illegalWrites: string[] = [];
let recN = 0;
const EXC = CONFIG_TABLES.exceptions;
(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
  await new Promise((r) => setTimeout(r, 1)); // real interleaving between concurrent requests
  const method = init?.method ?? "GET";
  const parts = new URL(url).pathname.split("/");
  const table = decodeURIComponent(parts[3]);
  requests.push({ method, table });
  if (method === "GET") {
    return new Response(JSON.stringify({ records: (tables[table] ?? []).map((r) => ({ id: r.id, fields: r.fields, createdTime: r.createdTime })) }), { status: 200 });
  }
  if (table !== EXC || !["POST", "PATCH"].includes(method)) {
    illegalWrites.push(`${method} ${table}`);
    throw new Error(`Illegal write ${method} ${table}`);
  }
  const body = JSON.parse(String(init?.body ?? "{}"));
  // Airtable omits false checkboxes / empty values when reading back.
  const clean = (f: Record<string, any>) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== false && v !== null && v !== ""));
  if (method === "POST") {
    const rec = { id: id("Exc" + String(++recN).padStart(4, "0")), fields: clean(body.fields), createdTime: NOW.toISOString() };
    tables[EXC] = [...(tables[EXC] ?? []), rec];
    return new Response(JSON.stringify(rec), { status: 200 });
  }
  const rid = parts[4];
  const row = (tables[EXC] ?? []).find((r) => r.id === rid);
  if (!row) return new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404 });
  row.fields = clean({ ...row.fields, ...body.fields });
  return new Response(JSON.stringify(row), { status: 200 });
};
RETRY_DELAYS_MS.length = 0;

// In-memory lock with the real client's ownership semantics.
let tokN = 0;
const held = new Map<string, string>();
const acquired: string[] = [];
const fakeLock: LockClient = {
  async acquire(key) {
    await new Promise((r) => setTimeout(r, 1));
    if (held.has(key)) return null;
    const t = `${String(++tokN).padStart(8, "0")}-aaaa-4000-8000-000000000000`;
    held.set(key, t);
    acquired.push(key);
    return t;
  },
  async release(key, token) {
    if (held.get(key) !== token) return false;
    held.delete(key);
    return true;
  },
};
/** A broken lock that always grants - used ONLY to prove the lock is what prevents duplicates. */
const noLock: LockClient = { async acquire() { return `${String(++tokN).padStart(8, "0")}-bbbb-4000-8000-000000000000`; }, async release() { return true; } };

const orgRow = (rid: string, oid: string) => ({ id: rid, fields: { "Organisation ID": oid, Active: true, Timezone: TZ, "Organisation Name": oid } });
function world(o: { sessions?: AirtableRecord[]; occurrences?: AirtableRecord[]; sessionStaff?: AirtableRecord[]; dates?: AirtableRecord[]; settings?: AirtableRecord[]; exceptions?: AirtableRecord[]; moduleOn?: boolean; orgs?: AirtableRecord[] }) {
  tables = {
    [CONFIG_TABLES.rules]: RULES,
    [CONFIG_TABLES.settings]: o.settings ?? [],
    [EXC]: o.exceptions ?? [],
    [CONFIG_TABLES.features]: [{ id: id("FeatCoach"), fields: o.moduleOn === false ? { "Feature Key": "module_coaches" } : { "Feature Key": "module_coaches", Enabled: true } }],
    [CONFIG_TABLES.organisations]: o.orgs ?? [orgRow(ORG, "ORG-TEST-001")],
    "Sessions": o.sessions ?? [],
    "Session Occurrences": o.occurrences ?? [],
    "Session Staff": o.sessionStaff ?? [],
    "Occurrence Staff": [],
    "Coach Roles": roles,
    "Coaches": COACHES,
    "Staff Availability Requests": o.dates ?? [],
    "Cover Responses": [],
  };
  requests = [];
  illegalWrites = [];
}
const MGMT: Caller = { userId: "user-mgmt-1", role: "management", active: true, organisationId: "ORG-TEST-001", displayName: "Morgan Manager", email: "manager@test.invalid" };
const deps: Deps = { airtable: { baseId: "appTESTTESTTEST01", token: "t" }, registry: IMPLEMENTED_EVALUATORS, lock: fakeLock };
const FAST = { maxAttempts: 3, retryDelayMs: 1 };
const create = (body: any, now = NOW, caller: Caller = MGMT, d: Deps = deps) => createException(d, caller, body, now, FAST) as Promise<any>;
const revoke = (body: any, now = NOW, caller: Caller = MGMT, d: Deps = deps) => revokeException(d, caller, body, now, FAST) as Promise<any>;
const q = (query: any = {}, now = NOW, caller: Caller = MGMT) => getCases(deps, caller, query, now) as Promise<any>;
const keys = (b: any) => b.cases.map((c: any) => c.caseKey).sort();
const excRows = () => tables[EXC] ?? [];
const writes = () => requests.filter((r) => r.method !== "GET");

// A staffing world: S1 requires a Lead + 2 staff, has only a Coach -> no_lead_coach AND session_understaffed on each occurrence.
const S1 = session(id("SessOne"), { lead: true, rsc: 2, name: "Probe One" });
const S2 = session(id("SessTwo"), { lead: true, rsc: 1, name: "Probe Two" });
const O1 = occ(id("OccOneA"), S1.id, 2 * D), O2 = occ(id("OccOneB"), S1.id, 3 * D), O3 = occ(id("OccTwoA"), S2.id, 2 * D);
const SS = [staff(S1.id, C1, ROLE_COACH), staff(S2.id, C2, ROLE_COACH)];
const K1 = `no_lead_coach|occurrence:${O1.id}`, K2 = `no_lead_coach|occurrence:${O2.id}`, K3 = `no_lead_coach|occurrence:${O3.id}`;
const U1 = `session_understaffed|occurrence:${O1.id}`;
const staffingWorld = (extra: Parameters<typeof world>[0] = {}) => world({ sessions: [S1, S2], occurrences: [O1, O2, O3], sessionStaff: SS, ...extra });
const REASON = "Agreed with the venue: Alex leads this one-off date";

async function main() {
  // ===== Pure policy (exceptions.ts) =====
  {
    const ok = parseCreateBody({ caseKey: K1, reason: "  padded reason  " }, NOW);
    ck("P1. Valid create body -> caseKey, ruleKey derived from the key, reason trimmed, effectiveUntil null (until revoked)", ok.ok && ok.value.ruleKey === "no_lead_coach" && ok.value.reason === "padded reason" && ok.value.effectiveUntil === null);
    const off = parseCreateBody({ caseKey: K1, reason: "r", effectiveUntil: "2026-10-05T19:00:00+01:00" }, NOW);
    ck("P2. effectiveUntil with an explicit offset is accepted and normalised to UTC", off.ok && off.value.effectiveUntil === "2026-10-05T18:00:00.000Z");
    const bad = (b: any) => { const r = parseCreateBody(b, NOW); return r.ok ? "ok" : r.code; };
    ck("P3. Reason missing / blank / whitespace -> reason_required", bad({ caseKey: K1 }) === "reason_required" && bad({ caseKey: K1, reason: "" }) === "reason_required" && bad({ caseKey: K1, reason: "   \n " }) === "reason_required" && bad({ caseKey: K1, reason: 42 }) === "reason_required");
    ck(`P4. Reason length: ${EXCEPTION_REASON_MAX} chars ok, ${EXCEPTION_REASON_MAX + 1} -> reason_too_long`, bad({ caseKey: K1, reason: "x".repeat(EXCEPTION_REASON_MAX) }) === "ok" && bad({ caseKey: K1, reason: "x".repeat(EXCEPTION_REASON_MAX + 1) }) === "reason_too_long");
    ck("P5. effectiveUntil in the past or exactly now -> effective_until_not_future", bad({ caseKey: K1, reason: "r", effectiveUntil: at(-1000) }) === "effective_until_not_future" && bad({ caseKey: K1, reason: "r", effectiveUntil: NOW.toISOString() }) === "effective_until_not_future");
    ck("P6. effectiveUntil without a timezone, date-only, or junk -> invalid_effective_until (ambiguous times refused)", ["2026-10-05T10:00:00", "2026-10-05", "next week", 12345, "2026-13-45T99:00:00Z"].every((v) => bad({ caseKey: K1, reason: "r", effectiveUntil: v }) === "invalid_effective_until"));
    ck("P7. Malformed caseKey / non-object body -> invalid_case_key / invalid_body", bad({ caseKey: "no lead coach", reason: "r" }) === "invalid_case_key" && bad({ caseKey: "no_lead_coach", reason: "r" }) === "invalid_case_key" && bad(null) === "invalid_body" && bad([K1]) === "invalid_body");
    ck("P8. Client-supplied organisation keys -> tenant_param_rejected", ["organisation", "organisationId", "organisation_id", "org", "tenant"].every((k) => bad({ caseKey: K1, reason: "r", [k]: "ORG-EVIL" }) === "tenant_param_rejected"));
    ck("P9. Client-supplied rule / approver / timestamps / target ids -> unexpected_field (server derives them)", ["rule", "ruleKey", "ruleId", "approvedBy", "approvedByName", "approvedAt", "sessionId", "occurrenceId", "active"].every((k) => bad({ caseKey: K1, reason: "r", [k]: "x" }) === "unexpected_field"));
    const rb = (b: any) => { const r = parseRevokeBody(b); return r.ok ? "ok" : r.code; };
    ck("P10. Revoke body needs exceptionId + a reason; nothing else accepted", rb({ exceptionId: "NAEX-1", reason: "done" }) === "ok" && rb({ exceptionId: "NAEX-1" }) === "reason_required" && rb({ reason: "x" }) === "invalid_exception_id" && rb({ exceptionId: "NAEX-1", reason: "x", organisation: "O" }) === "tenant_param_rejected" && rb({ exceptionId: "NAEX-1", reason: "x", revokedBy: "me" }) === "unexpected_field");
    ck("P11. Approver identity comes from the profile: display name, else email, else user id", actorFromProfile({ userId: "u1", displayName: " Pat ", email: "p@x" }).name === "Pat" && actorFromProfile({ userId: "u1", displayName: "", email: "p@x" }).name === "p@x" && actorFromProfile({ userId: "u1" }).name === "u1");
    ck("P12. Exception ID = NAEX-<UTC yyyymmddhhmmss>-<first 8 of the owned lock token>", buildExceptionId(NOW, "abcdef12-3456-4000-8000-000000000000") === "NAEX-20261001100000-ABCDEF12");
    const links = contextLinksFromCase({ targetIds: { sessionId: S1.id, occurrenceId: "not-a-record", venueId: id("Venue1") } } as any);
    ck("P13. Context links only from well-formed record ids in the REAL case's targetIds (venue ignored, junk dropped)", links.sessionId === S1.id && links.occurrenceId === null && links.coachId === null && links.playerId === null);
    const rf = buildRevokeFields({ revoker: { userId: "u9", name: "Rev" }, now: NOW, reason: "why" });
    ck("P14. Revoke fields touch ONLY Active + the four revoke audit fields (never the approval snapshot)", JSON.stringify(Object.keys(rf).sort()) === JSON.stringify(["Active", "Revoke Reason", "Revoked At", "Revoked By Name Snapshot", "Revoked By User ID"]) && rf.Active === false);
    const rows = [
      parseException({ id: id("ExA"), fields: { "Exception ID": "NAEX-A", Organisation: [ORG], Active: true, "Case Key": K1 } }),
      parseException({ id: id("ExB"), fields: { "Exception ID": "NAEX-B", Organisation: [ORG, ORG2], Active: true, "Case Key": K1 } }),
      parseException({ id: id("ExC"), fields: { "Exception ID": "NAEX-C", Organisation: [ORG2], Active: true, "Case Key": K1 } }),
    ];
    ck("P15. findOwnedException: only rows linked to exactly the caller's organisation (by Exception ID or record id)", findOwnedException(rows, ORG, "NAEX-A")?.recordId === id("ExA") && findOwnedException(rows, ORG, id("ExA"))?.exceptionId === "NAEX-A" && findOwnedException(rows, ORG, "NAEX-B") === null && findOwnedException(rows, ORG, "NAEX-C") === null);
    const exp = [parseException({ id: id("ExD"), fields: { Organisation: [ORG], Active: true, "Case Key": K1, "Effective Until": at(-1) } }), parseException({ id: id("ExE"), fields: { Organisation: [ORG], "Case Key": K1 } })];
    ck("P16. inForceFor ignores expired and inactive rows", inForceFor(exp, ORG, K1, NOW).length === 0 && inForceFor([rows[0]], ORG, K1, NOW).length === 1);
  }

  // ===== Valid create: server-derived identity, exact suppression, no source mutation =====
  let createdId = "", createdRec = "";
  {
    staffingWorld();
    const before = await q();
    ck("C0. Precondition: no_lead_coach on O1, O2 (same session) and O3 (other session); session_understaffed on O1", [K1, K2, K3, U1].every((k) => keys(before.body).includes(k)) && before.body.summary.suppressed === 0);
    const sourceSnapshot = JSON.stringify(["Sessions", "Session Occurrences", "Session Staff", "Occurrence Staff", "Coaches", "Coach Roles"].map((t) => tables[t]));
    requests = [];
    const r = await create({ caseKey: K1, reason: `  ${REASON}  ` });
    ck("C1. POST valid case -> 201 created", r.status === "ok" && r.httpStatus === 201 && r.body.created === true, JSON.stringify(r).slice(0, 300));
    const row = excRows()[0];
    createdId = r.body?.exception?.exceptionId ?? ""; createdRec = row?.id ?? "";
    const f = row?.fields ?? {};
    ck("C2. Exactly one row written; organisation = the caller's org record, rule = the case's rule record, Case Key exact", excRows().length === 1 && JSON.stringify(f.Organisation) === JSON.stringify([ORG]) && JSON.stringify(f.Rule) === JSON.stringify([NLC_RULE.id]) && f["Case Key"] === K1);
    ck("C3. Context links derived from the real case: Session = S1, Session Occurrence = O1; no Coach / Player", JSON.stringify(f.Session) === JSON.stringify([S1.id]) && JSON.stringify(f["Session Occurrence"]) === JSON.stringify([O1.id]) && !("Coach" in f) && !("Player" in f));
    ck("C4. Audit: approver id + name from the profile, Approved At = server now, reason trimmed, Active, no expiry", f["Approved By User ID"] === "user-mgmt-1" && f["Approved By Name Snapshot"] === "Morgan Manager" && f["Approved At"] === NOW.toISOString() && f.Reason === REASON && f.Active === true && !("Effective Until" in f));
    ck("C5. Exception ID generated server-side (NAEX-<ts>-<token>)", /^NAEX-20261001100000-[0-9A-Z]{8}$/.test(f["Exception ID"] ?? "") && createdId === f["Exception ID"]);
    ck("C6. Response: exception view (id, caseKey, ruleKey, organisation, reason, approvedBy, approvedAt, effectiveUntil, active) + case suppressed", r.body.exception.caseKey === K1 && r.body.exception.ruleKey === "no_lead_coach" && r.body.exception.organisation === "ORG-TEST-001" && r.body.exception.reason === REASON && r.body.exception.approvedBy.name === "Morgan Manager" && r.body.exception.approvedAt === NOW.toISOString() && r.body.exception.effectiveUntil === null && r.body.exception.active === true && r.body.case.suppressed === true && r.body.case.ruleId === "ATT-001");
    ck("C7. Writes: exactly one POST to Needs Attention Exceptions; no other table written", writes().length === 1 && writes()[0].method === "POST" && writes()[0].table === EXC && illegalWrites.length === 0);
    ck("C8. Reads: 5 config + the 6 staffing sources only (the case's rule, not every rule), each once", Object.keys(r.body.reads.lists).length === 11 && Object.values(r.body.reads.lists).every((n: any) => n === 1) && !r.body.reads.lists["Staff Availability Requests"]);
    ck("C9. Source data unchanged (an exception never edits staffing truth)", JSON.stringify(["Sessions", "Session Occurrences", "Session Staff", "Occurrence Staff", "Coaches", "Coach Roles"].map((t) => tables[t])) === sourceSnapshot);
    const after = await q();
    ck("C10. Queue: the excepted case disappears; summary.suppressed = 1", !keys(after.body).includes(K1) && after.body.summary.suppressed === 1 && after.body.summary.total === before.body.summary.total - 1);
    ck("C11. Exact-case isolation: same rule on another occurrence of the SAME session (O2), another session (O3), and another rule on the SAME occurrence (session_understaffed/O1) all remain", [K2, K3, U1].every((k) => keys(after.body).includes(k)));
    const lk = await q({ caseKey: K1 });
    ck("C12. caseKey lookup reports the case as suppressed (exists false, suppressed true)", lk.body.exists === false && lk.body.suppressed === true);
    const dbg = await q({ debug: true });
    ck("C13. debug lists the suppression with its exception id", dbg.body.diagnostics.suppressedCases.length === 1 && dbg.body.diagnostics.suppressedCases[0].exceptionId === createdId);
    ck("C14. The lock was taken on organisation + Case Key and released", acquired.includes(`ORG-TEST-001|${K1}`) && held.size === 0);
  }

  // ===== Duplicates + concurrency =====
  {
    const dup = await create({ caseKey: K1, reason: "again" });
    ck("U1. Second create for the same case -> 409 exception_exists, returns the existing exception, no new row", dup.status === "rejected" && dup.httpStatus === 409 && dup.code === "exception_exists" && dup.body?.exception?.exceptionId === createdId && excRows().length === 1);
    staffingWorld();
    const [a, b] = await Promise.all([create({ caseKey: K2, reason: "first" }), create({ caseKey: K2, reason: "second" })]);
    const oks = [a, b].filter((x) => x.status === "ok").length, conflicts = [a, b].filter((x) => x.code === "exception_exists").length;
    ck("U2. Two simultaneous creates for one case -> exactly one 201 + one 409; one active row", oks === 1 && conflicts === 1 && excRows().filter((r) => r.fields.Active === true && r.fields["Case Key"] === K2).length === 1 && held.size === 0, `${a.code ?? a.status}/${b.code ?? b.status}`);
    staffingWorld();
    const [c, d] = await Promise.all([create({ caseKey: K2, reason: "x" }), create({ caseKey: K3, reason: "y" })]);
    ck("U3. Simultaneous creates for DIFFERENT cases do not block each other (lock is per case)", c.status === "ok" && d.status === "ok" && excRows().length === 2);
    staffingWorld();
    const broken = { ...deps, lock: noLock };
    await Promise.all([create({ caseKey: K2, reason: "x" }, NOW, MGMT, broken), create({ caseKey: K2, reason: "y" }, NOW, MGMT, broken)]);
    ck("U4. Control: with a lock that always grants, the same race DOES write two active rows (the lock is what prevents it)", excRows().length === 2);
    staffingWorld();
    held.set(`ORG-TEST-001|${K2}`, "someone-else");
    const busy = await create({ caseKey: K2, reason: "x" });
    held.clear();
    ck("U5. Lock held by another request past the retry budget -> 409 lock_busy, nothing written", busy.code === "lock_busy" && busy.httpStatus === 409 && excRows().length === 0);
  }

  // ===== Revoke =====
  {
    staffingWorld();
    const c = await create({ caseKey: K1, reason: REASON });
    const approval = JSON.stringify(Object.fromEntries(Object.entries(excRows()[0].fields).filter(([k]) => ["Exception ID", "Organisation", "Rule", "Case Key", "Reason", "Approved By User ID", "Approved By Name Snapshot", "Approved At", "Session", "Session Occurrence"].includes(k))));
    const T2 = later(2 * H);
    const REV: Caller = { ...MGMT, userId: "user-mgmt-2", displayName: "Riley Reviewer" };
    requests = [];
    const r = await revoke({ exceptionId: c.body.exception.exceptionId, reason: "  Lead now booked  " }, T2, REV);
    const f = excRows()[0].fields;
    ck("R1. Revoke -> 200, revoked, exception active = false", r.status === "ok" && r.httpStatus === 200 && r.body.revoked === true && r.body.exception.active === false, JSON.stringify(r).slice(0, 300));
    ck("R2. Record kept (never deleted): Active cleared; Revoked At = server now; revoker id + name from profile; Revoke Reason trimmed", excRows().length === 1 && f.Active !== true && f["Revoked At"] === T2.toISOString() && f["Revoked By User ID"] === "user-mgmt-2" && f["Revoked By Name Snapshot"] === "Riley Reviewer" && f["Revoke Reason"] === "Lead now booked");
    ck("R3. Approval snapshot untouched by revoke (approver, reason, Approved At, links)", JSON.stringify(Object.fromEntries(Object.entries(f).filter(([k]) => ["Exception ID", "Organisation", "Rule", "Case Key", "Reason", "Approved By User ID", "Approved By Name Snapshot", "Approved At", "Session", "Session Occurrence"].includes(k)))) === approval);
    ck("R4. Response reports the re-evaluated case: visible again (problem still present)", r.body.case.visibleAgain === true && r.body.case.reason === "problem_still_present" && r.body.exception.revoked?.by?.name === "Riley Reviewer");
    ck("R5. Writes: exactly one PATCH to Needs Attention Exceptions", writes().length === 1 && writes()[0].method === "PATCH" && writes()[0].table === EXC && illegalWrites.length === 0);
    const after = await q({}, T2);
    ck("R6. Queue: the case is back immediately; suppressed = 0", keys(after.body).includes(K1) && after.body.summary.suppressed === 0);
    const again = await revoke({ exceptionId: c.body.exception.exceptionId, reason: "x" }, T2);
    ck("R7. Revoking again -> 409 already_revoked, nothing changed", again.code === "already_revoked" && again.httpStatus === 409 && excRows()[0].fields["Revoked By User ID"] === "user-mgmt-2");
    const byRec = await create({ caseKey: K1, reason: "re-approved" }, T2);
    ck("R8. After revoke a NEW exception can be approved (new row; old one kept inactive)", byRec.status === "ok" && excRows().length === 2 && excRows().filter((x) => x.fields.Active === true).length === 1);
    const byRecordId = await revoke({ exceptionId: excRows()[1].id, reason: "by record id" }, T2);
    ck("R9. Revoke also accepts the exception's record id", byRecordId.status === "ok" && excRows()[1].fields.Active !== true);
    ck("R10. Unknown exception id -> 404 exception_not_found", (await revoke({ exceptionId: "NAEX-NOPE", reason: "x" })).code === "exception_not_found");
    staffingWorld({ exceptions: [{ id: id("ExOther"), fields: { "Exception ID": "NAEX-OTHER", Organisation: [ORG2], Rule: [NLC_RULE.id], "Case Key": K1, Active: true } }] });
    const other = await revoke({ exceptionId: "NAEX-OTHER", reason: "x" });
    const otherByRec = await revoke({ exceptionId: id("ExOther"), reason: "x" });
    ck("R11. Another organisation's exception cannot be revoked by Exception ID or by record id (404, untouched)", other.code === "exception_not_found" && otherByRec.code === "exception_not_found" && excRows()[0].fields.Active === true && writes().length === 0);
    staffingWorld();
    const cc = await create({ caseKey: K1, reason: "r" });
    tables["Session Staff"] = [...SS, staff(S1.id, C2, ROLE_LEAD)]; // fix the source: a Lead now staffs S1
    const fixedRevoke = await revoke({ exceptionId: cc.body.exception.exceptionId, reason: "no longer needed" });
    ck("R12. Revoke after the source was fixed -> visibleAgain false (problem_no_longer_present)", fixedRevoke.status === "ok" && fixedRevoke.body.case.visibleAgain === false && fixedRevoke.body.case.reason === "problem_no_longer_present");
  }

  // ===== Expiry (read-time only) =====
  {
    staffingWorld();
    const until = at(2 * H);
    const c = await create({ caseKey: K1, reason: "until kick-off", effectiveUntil: until });
    const stored = JSON.stringify(excRows()[0].fields);
    ck("X1. Create with effectiveUntil -> stored as the UTC instant", c.status === "ok" && excRows()[0].fields["Effective Until"] === until && c.body.exception.effectiveUntil === until);
    ck("X2. Before expiry (now + 1h59m59.999s) -> suppressed", !keys((await q({}, later(2 * H - 1))).body).includes(K1));
    ck("X3. At expiry exactly -> the case returns (Effective Until must be strictly in the future)", keys((await q({}, later(2 * H))).body).includes(K1));
    ck("X4. After expiry -> visible; the stored exception is unchanged (still Active; no cleanup write)", keys((await q({}, later(3 * H))).body).includes(K1) && JSON.stringify(excRows()[0].fields) === stored && writes().filter((w) => w.method !== "POST").length === 0);
    const again = await create({ caseKey: K1, reason: "new window" }, later(3 * H));
    ck("X5. An expired exception is not 'in force': a new exception can be created after expiry", again.status === "ok" && excRows().length === 2);
  }

  // ===== Case must genuinely exist =====
  {
    staffingWorld();
    const guess = await create({ caseKey: `no_lead_coach|occurrence:${id("OccGuess")}`, reason: "r" });
    ck("E1. Guessed Case Key (well-formed, no such case) -> 404 case_not_found, nothing written", guess.code === "case_not_found" && guess.httpStatus === 404 && excRows().length === 0);
    const unknownRule = await create({ caseKey: `made_up_rule|occurrence:${O1.id}`, reason: "r" });
    ck("E2. Unknown rule key -> 404 case_not_found", unknownRule.code === "case_not_found" && excRows().length === 0);
    const wrongType = await create({ caseKey: `no_lead_coach|session:${S1.id}`, reason: "r" });
    ck("E3. Right rule, wrong subject (session instead of occurrence) -> 404 (no broad session-wide exceptions)", wrongType.code === "case_not_found" && excRows().length === 0);
    tables["Session Staff"] = [...SS, staff(S1.id, C2, ROLE_LEAD)];
    const gone = await create({ caseKey: K1, reason: "r" });
    ck("E4. Case already resolved at source (a Lead now staffs S1) -> 404, nothing written", gone.code === "case_not_found" && excRows().length === 0);
    staffingWorld({ moduleOn: false });
    const off = await create({ caseKey: K1, reason: "r" });
    ck("E5. Module off -> the rule is not evaluated -> 404 case_not_found", off.code === "case_not_found" && /module/.test(off.error) && excRows().length === 0);
    staffingWorld();
    const throwing = { ...deps, registry: IMPLEMENTED_EVALUATORS.map((e) => (e.ruleKey === "no_lead_coach" ? { ...e, evaluate: () => { throw new Error("boom"); } } : e)) };
    const inc = await create({ caseKey: K1, reason: "r" }, NOW, MGMT, throwing);
    ck("E6. Evaluator failure -> 409 evaluation_incomplete (never a blind write)", inc.code === "evaluation_incomplete" && excRows().length === 0);
  }

  // ===== Override rules =====
  {
    const SC = session(id("SessCov"), { name: "Cover probe" });
    const OC = occ(id("OccCov"), SC.id, 4 * D);
    const RD = { id: id("RdCov"), fields: { "Request ID": "COVER-x", "Request Type": "Cover Request", Coach: [C1], "Cover Date Status": "Open", "Session Occurrence": [OC.id] }, createdTime: at(-H) };
    world({ sessions: [SC], occurrences: [OC], sessionStaff: [staff(SC.id, C1, ROLE_COACH)], dates: [RD] });
    const ck1 = `cover_open|coverdate:${RD.id}`;
    ck("O0. Precondition: the cover_open case exists", keys((await q()).body).includes(ck1));
    const cov = await create({ caseKey: ck1, reason: "r" });
    ck("O1. cover_open (ATT-041 Supports Override = No) -> 403 override_not_supported, nothing written, cover date untouched", cov.code === "override_not_supported" && cov.httpStatus === 403 && excRows().length === 0 && tables["Staff Availability Requests"][0].fields["Cover Date Status"] === "Open" && illegalWrites.length === 0);
    const setting = (allow: boolean) => ({ id: id("SetNlc"), fields: { "Setting ID": "SET-1", Organisation: [ORG], Rule: [NLC_RULE.id], Enabled: true, ...(allow ? { "Allow Override": true } : {}) } });
    staffingWorld({ settings: [setting(false)] });
    const dis = await create({ caseKey: K1, reason: "r" });
    ck("O2. Organisation Settings Allow Override = off -> 403 override_disabled_by_settings, nothing written", dis.code === "override_disabled_by_settings" && dis.httpStatus === 403 && excRows().length === 0);
    staffingWorld({ settings: [setting(true)] });
    ck("O3. Settings Allow Override = on -> allowed", (await create({ caseKey: K1, reason: "r" })).status === "ok");
    staffingWorld({ exceptions: [{ id: id("ExPre"), fields: { "Exception ID": "NAEX-PRE", Organisation: [ORG], Rule: [NLC_RULE.id], "Case Key": K1, Active: true } }], settings: [setting(false)] });
    const pre = await q();
    ck("O4. An existing exception stops suppressing once Allow Override is switched off (read side unchanged)", keys(pre.body).includes(K1) && pre.body.summary.suppressed === 0);
  }

  // ===== Permissions + organisation scope =====
  {
    staffingWorld();
    const denied = async (c: Caller) => (await create({ caseKey: K1, reason: "r" }, NOW, c)).httpStatus;
    ck("S1. Coach / Parent / pending / inactive Management -> 403 on create (orchestrator guard as well as index.ts)", (await denied({ ...MGMT, role: "coach" })) === 403 && (await denied({ ...MGMT, role: "parent" })) === 403 && (await denied({ ...MGMT, role: "pending" })) === 403 && (await denied({ ...MGMT, active: false })) === 403 && excRows().length === 0);
    const rdenied = async (c: Caller) => (await revoke({ exceptionId: "NAEX-1", reason: "r" }, NOW, c)).httpStatus;
    ck("S2. Same for revoke", (await rdenied({ ...MGMT, role: "coach" })) === 403 && (await rdenied({ ...MGMT, active: false })) === 403);
    ck("S3. Management with no organisation on the profile -> 409, nothing read or written", (await create({ caseKey: K1, reason: "r" }, NOW, { ...MGMT, organisationId: null })).httpStatus === 409 && excRows().length === 0);
    ck("S4. Profile organisation not found among active organisations -> 409 organisation_not_found", (await create({ caseKey: K1, reason: "r" }, NOW, { ...MGMT, organisationId: "ORG-NOPE" })).code === "organisation_not_found" && excRows().length === 0);
    staffingWorld({ orgs: [orgRow(ORG, "ORG-TEST-001"), orgRow(ORG2, "ORG-OTHER")] });
    const OTHER: Caller = { ...MGMT, userId: "user-other", organisationId: "ORG-OTHER" };
    const oc = await create({ caseKey: K1, reason: "other org's own decision" }, NOW, OTHER);
    ck("S5. Another organisation's Management writes an exception linked ONLY to their own organisation", oc.status === "ok" && JSON.stringify(excRows()[0].fields.Organisation) === JSON.stringify([ORG2]) && oc.body.exception.organisation === "ORG-OTHER");
    ck("S6. ...which does NOT suppress the case for ORG-TEST-001, and ORG-TEST-001 may approve its own", keys((await q()).body).includes(K1) && (await create({ caseKey: K1, reason: "ours" })).status === "ok" && excRows().length === 2);
    const cross = await revoke({ exceptionId: oc.body.exception.exceptionId, reason: "x" });
    ck("S7. ORG-TEST-001 cannot revoke ORG-OTHER's exception (404)", cross.code === "exception_not_found" && excRows()[0].fields.Active === true);
  }

  // ===== Read side unchanged + matcher agreement =====
  {
    const row = parseException({ id: id("ExM"), fields: { Organisation: [ORG], Rule: [NLC_RULE.id], "Case Key": K1, Active: true, "Effective Until": at(H) } });
    const ruleDef = { recordId: NLC_RULE.id, ruleKey: "no_lead_coach" } as any;
    ck("M1. Created rows are matched by the unchanged Slice 2 matcher (exact org + rule + key, active, unexpired)", !!matchException([row], { organisationRecordId: ORG, rule: ruleDef, caseKey: K1, overrideAllowed: true, now: NOW }) && !matchException([row], { organisationRecordId: ORG, rule: ruleDef, caseKey: K2, overrideAllowed: true, now: NOW }) && !matchException([row], { organisationRecordId: ORG2, rule: ruleDef, caseKey: K1, overrideAllowed: true, now: NOW }) && !matchException([row], { organisationRecordId: ORG, rule: ruleDef, caseKey: K1, overrideAllowed: true, now: later(H) }));
  }

  // ===== Code / drift checks =====
  {
    const canon = (f: string) => readFileSync(join(CANON, f), "utf8");
    const pure = canon("exceptions.ts");
    ck("Z1. exceptions.ts is pure policy: no fetch, no Airtable/Supabase, no Deno", !/fetch\(|airtable|Airtable\.|supabase|Deno\./i.test(pure.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
    const lc = canon("lock-client.ts"), cover = readFileSync(join(CANON, "..", "coach-cover", "lock-client.ts"), "utf8");
    const body = (s: string) => s.slice(s.indexOf("export interface SupabaseLockConfig"));
    ck("Z2. lock-client.ts = coach-cover's proven lock client with only the RPC names/argument renamed", body(lc) === body(cover).replace('"acquire_cover_date_lock", { p_cover_date_record_id: key }', '"acquire_needs_attention_exception_lock", { p_exception_key: key }').replace('"release_cover_date_lock", { p_cover_date_record_id: key, p_lock_token: lockToken }', '"release_needs_attention_exception_lock", { p_exception_key: key, p_lock_token: lockToken }'));
    const orch = canon("orchestrator.ts");
    ck("Z3. Create and revoke both run under withLock keyed by exceptionLockKey(profile org, Case Key)", (orch.match(/withLock\(\s*deps\.lock,/g) ?? []).length === 2 && (orch.match(/exceptionLockKey\(caller\.organisationId!\.trim\(\)/g) ?? []).length === 2);
    ck("Z4. No delete route or delete call exists", !/DELETE|delete_records|\.delete\(/.test(canon("index.ts") + canon("repository.ts") + orch + pure));
  }

  for (const [s, n, e] of R) console.log(`${s}  ${n}${e && s === "FAIL" ? `  [${e}]` : ""}`);
  const passed = R.filter((r) => r[0] === "PASS").length;
  console.log(`\n${passed}/${R.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
