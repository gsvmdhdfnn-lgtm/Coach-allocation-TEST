// Whole-backend audit P1 correction slice (see TEST-ENV.md, "P1 correction
// slice"):
//   P1-1 profiles.active enforced in parent-hub (every route) and
//        hub-content /players;
//   P1-2 Parent find-or-create serialised per organisation + user, and
//        fail-closed `parent_id_ambiguous` instead of byUserId[0].
//
// No hand-kept mirrors here. The REAL functions-test/parent-hub/index.ts
// and hub-content/index.ts are bundled with esbuild and booted with a stub
// Deno, a stub supabase-js and an in-memory Airtable + PostgREST behind
// fetch. Where "unchanged" is the claim, the same requests also run
// against the b24dc60 versions of the same files (git show) and the
// responses are compared byte for byte. parent-identity.ts is imported
// directly (it is portable: plain fetch only).
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import {
  type ParentIdentityDeps,
  type ParentRecord,
  ParentIdentityError,
  makeParentId,
  resolveParentIdentity,
} from "../../supabase/functions-test/parent-hub/parent-identity.ts";

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const FUNCS = join(ROOT, "supabase", "functions-test");
const BASELINE = "b24dc60";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------
// In-memory world: Airtable tables, profiles, auth users, locks.
// ---------------------------------------------------------------------
const TBL_PARENTS = "tbl2NC4oLuC4ZUFvD";
const TBL_LINKS = "tblMrzy6TmiNPXqUG";
const TABLE_ALIASES: Record<string, string> = { [TBL_PARENTS]: "Parents & Guardians", [TBL_LINKS]: "Parent–Player Links" };
type Rec = { id: string; createdTime: string; fields: Record<string, any> };
type Profile = { user_id: string; role: string; active: boolean; organisation_id: string; airtable_person_id: string | null; display_name: string | null };

interface World {
  tables: Record<string, Rec[]>;
  profiles: Profile[];
  users: Record<string, { id: string; email: string }>;
  locks: Map<string, string>;
  airtableDelayMs: number;
  faults: { createFailAfterWrite: number; createFailBeforeWrite: number; releaseFail: number };
  calls: { creates: number /* Parents & Guardians creates */; patches: string[]; lockAcquires: number; lockReleases: number };
}
let W: World;
let recSeq = 0;
const recId = () => "rec" + ("P1" + (++recSeq).toString().padStart(4, "0") + "ZZZZZZZZZZZZ").slice(0, 14);
function newWorld(): World {
  return {
    tables: {},
    profiles: [],
    users: {},
    locks: new Map(),
    airtableDelayMs: 4,
    faults: { createFailAfterWrite: 0, createFailBeforeWrite: 0, releaseFail: 0 },
    calls: { creates: 0, patches: [], lockAcquires: 0, lockReleases: 0 },
  };
}
const table = (name: string) => (W.tables[TABLE_ALIASES[name] || name] ||= []);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function fakeAirtable(url: URL, init: RequestInit): Promise<Response> {
  await sleep(W.airtableDelayMs);
  const parts = url.pathname.split("/").filter(Boolean); // v0, base, table, [id]
  const rows = table(decodeURIComponent(parts[2]));
  const id = parts[3];
  const method = (init.method || "GET").toUpperCase();
  if (method === "GET" && id) {
    const r = rows.find((x) => x.id === id);
    return r ? json(structuredClone(r)) : json({ error: "NOT_FOUND" }, 404);
  }
  if (method === "GET") {
    const formula = url.searchParams.get("filterByFormula");
    let out = rows;
    if (formula) {
      const m = formula.match(/^\{(.+)\} = "(.*)"$/);
      if (!m) return json({ error: "bad formula" }, 422);
      const value = m[2].replace(/\\"/g, '"');
      out = rows.filter((r) => String(r.fields[m[1]] ?? "") === value);
    }
    return json({ records: structuredClone(out) });
  }
  if (method === "POST") {
    const tname = TABLE_ALIASES[decodeURIComponent(parts[2])] || decodeURIComponent(parts[2]);
    if (tname !== "Parents & Guardians") {
      const body = JSON.parse(String(init.body));
      const rec: Rec = { id: recId(), createdTime: new Date().toISOString(), fields: { ...body.records[0].fields } };
      rows.push(rec);
      return json({ records: [structuredClone(rec)] });
    }
    W.calls.creates++; // Parent creates only
    if (W.faults.createFailBeforeWrite > 0) { W.faults.createFailBeforeWrite--; return json({ error: "SERVER_ERROR" }, 503); }
    const body = JSON.parse(String(init.body));
    const rec: Rec = { id: recId(), createdTime: new Date().toISOString(), fields: { ...body.records[0].fields } };
    rows.push(rec);
    if (W.faults.createFailAfterWrite > 0) { W.faults.createFailAfterWrite--; return json({ error: "GATEWAY_TIMEOUT" }, 504); }
    return json({ records: [structuredClone(rec)] });
  }
  if (method === "PATCH") {
    const r = rows.find((x) => x.id === id);
    if (!r) return json({ error: "NOT_FOUND" }, 404);
    W.calls.patches.push(id);
    Object.assign(r.fields, JSON.parse(String(init.body)).fields);
    return json(structuredClone(r));
  }
  return json({ error: "unsupported" }, 405);
}

async function fakeSupabase(url: URL, init: RequestInit): Promise<Response> {
  const method = (init.method || "GET").toUpperCase();
  if (url.pathname === "/rest/v1/rpc/acquire_parent_identity_lock") {
    const a = JSON.parse(String(init.body));
    W.calls.lockAcquires++;
    if (!a.p_organisation_id || !a.p_user_id) return json({ message: "parent identity lock needs organisation_id and user_id" }, 400);
    const key = `${a.p_organisation_id}|${a.p_user_id}`;
    if (W.locks.has(key)) return json(null);
    const token = crypto.randomUUID();
    W.locks.set(key, token);
    return json(token);
  }
  if (url.pathname === "/rest/v1/rpc/release_parent_identity_lock") {
    const a = JSON.parse(String(init.body));
    W.calls.lockReleases++;
    if (W.faults.releaseFail > 0) { W.faults.releaseFail--; return json({ message: "boom" }, 500); }
    const key = `${a.p_organisation_id}|${a.p_user_id}`;
    if (W.locks.get(key) === a.p_lock_token) { W.locks.delete(key); return json(true); }
    return json(false);
  }
  if (url.pathname === "/rest/v1/profiles") {
    const uid = (url.searchParams.get("user_id") || "").replace(/^eq\./, "");
    const p = W.profiles.find((x) => x.user_id === uid);
    if (method === "GET") return json(p ? [{ airtable_person_id: p.airtable_person_id }] : []);
    if (method === "PATCH") {
      const onlyNull = url.searchParams.get("airtable_person_id") === "is.null";
      if (p && (!onlyNull || p.airtable_person_id == null)) p.airtable_person_id = JSON.parse(String(init.body)).airtable_person_id;
      return new Response(null, { status: 204 });
    }
  }
  return json({ message: `unhandled ${method} ${url.pathname}` }, 404);
}

globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname === "api.airtable.com") return fakeAirtable(url, init);
  if (url.hostname === "fake.supabase.test") return fakeSupabase(url, init);
  return json({ error: `unexpected fetch ${url}` }, 599);
}) as typeof fetch;

// Stub supabase-js: the bundles import createClient from this module.
(globalThis as any).__P1_WORLD = () => W;
const SUPABASE_STUB = `export function createClient(url, key, opts) {
  const W = globalThis.__P1_WORLD();
  const auth = ((opts && opts.global && opts.global.headers && opts.global.headers.Authorization) || "").replace("Bearer ", "");
  return {
    auth: { getUser: async () => { const u = W.users[auth]; return u ? { data: { user: { id: u.id, email: u.email } }, error: null } : { data: { user: null }, error: { message: "invalid" } }; } },
    from(t) {
      const eqs = []; let inF = null;
      const b = {
        select() { return b; }, update() { return b; }, is() { return b; },
        eq(c, v) { eqs.push([c, v]); return b; },
        in(c, v) { inF = [c, v]; return Promise.resolve({ data: W.profiles.filter((p) => v.includes(p[c])), error: null }); },
        async single() { const r = W.profiles.find((p) => eqs.every(([c, v]) => p[c] === v)); return r ? { data: { ...r }, error: null } : { data: null, error: { message: "no rows" } }; },
      };
      return b;
    },
  };
}`;

// ---------------------------------------------------------------------
// Bundle + boot a function (current file or the baseline commit's file).
// ---------------------------------------------------------------------
type Handler = (req: Request) => Promise<Response>;
const ENV: Record<string, string> = {
  AIRTABLE_BASE_ID: "appQktredAuGa1X7e",
  AIRTABLE_TOKEN: "test-airtable-token",
  SUPABASE_URL: "https://fake.supabase.test",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
};
let bootSlot: Handler | null = null;
(globalThis as any).Deno = { env: { get: (k: string) => ENV[k] ?? "" }, serve: (h: Handler) => { bootSlot = h; } };
const TMP = mkdtempSync(join(tmpdir(), "p1-corrections-"));
let bootSeq = 0;
async function boot(fn: string, files: string[], fromBaseline: boolean): Promise<Handler> {
  const dir = join(TMP, `${fn}-${fromBaseline ? "base" : "head"}`);
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const src = fromBaseline
      ? execFileSync("git", ["show", `${BASELINE}:supabase/functions-test/${fn}/${f}`], { cwd: ROOT, encoding: "utf8" })
      : readFileSync(join(FUNCS, fn, f), "utf8");
    writeFileSync(join(dir, f), src);
  }
  const out = await esbuild.build({ entryPoints: [join(dir, "index.ts")], bundle: true, format: "esm", platform: "neutral", write: false, external: ["jsr:*"], logLevel: "silent" });
  const code = out.outputFiles[0].text.replace(/"jsr:@supabase\/supabase-js@2"/g, JSON.stringify("data:text/javascript," + encodeURIComponent(SUPABASE_STUB)));
  const file = join(dir, `bundle-${++bootSeq}.mjs`);
  writeFileSync(file, code);
  bootSlot = null;
  await import(pathToFileURL(file).href);
  if (!bootSlot) throw new Error(`${fn} did not register a handler`);
  return bootSlot;
}

const call = async (h: Handler, fn: string, method: string, path: string, token?: string, body?: unknown) => {
  const res = await h(new Request(`https://fake.supabase.test/functions/v1/${fn}/${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }));
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, text };
};

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------
const ORG = "ORG-TEST-001";
const U = {
  mgmt: "11111111-1111-4111-8111-111111111111",
  parent: "22222222-2222-4222-8222-222222222222",
  coachA: "33333333-3333-4333-8333-333333333333",
  coachB: "44444444-4444-4444-8444-444444444444",
  learn: "55555555-5555-4555-8555-555555555555",
  cover: "66666666-6666-4666-8666-666666666666",
  fresh: "77777777-7777-4777-8777-777777777777",
  dupe: "88888888-8888-4888-8888-888888888888",
  other: "99999999-9999-4999-8999-999999999999",
};
const rid = (tag: string) => "rec" + (tag + "00000000000000").slice(0, 14);
function ukTodayIso(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
const TODAY = ukTodayIso();
const daysAgo = (n: number) => { const d = new Date(TODAY + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

const C = { A: rid("CoachA"), B: rid("CoachB"), L: rid("CoachL"), J: rid("CoachJ"), M: rid("CoachM") };
const ROLE = { lead: rid("RoleLead"), coach: rid("RoleCoach"), learn: rid("RoleLearn") };
const S1 = rid("SessOne"), S2 = rid("SessTwo");
const P = { one: rid("PlayOne"), two: rid("PlayTwo"), three: rid("PlayThree") };
const PARENT_REC = rid("ParentOne");
const LINK_VERIFIED = rid("LinkVer"), LINK_PENDING = rid("LinkPend");

function seed(): void {
  W = newWorld();
  const mk = (id: string, fields: Record<string, any>): Rec => ({ id, createdTime: "2026-09-01T00:00:00.000Z", fields });
  W.tables["Coach Roles"] = [
    mk(ROLE.lead, { "Role Name": "Lead Coach", "Role Key": "lead_coach", Active: true, "Can View Players": true, "Can Add Feedback": true, "Can Edit Development Plans": true, "Can Record Attendance": true }),
    mk(ROLE.coach, { "Role Name": "Coach", "Role Key": "coach", Active: true, "Can View Players": true, "Can Add Feedback": true, "Can Record Attendance": true }),
    mk(ROLE.learn, { "Role Name": "Learning Coach", "Role Key": "learning_coach", Active: true }),
  ];
  W.tables["Coaches"] = [
    mk(C.A, { "Coach Name": "Alex Lead", Active: true }), mk(C.B, { "Coach Name": "Bea Coach", Active: true }),
    mk(C.L, { "Coach Name": "Lou Learner", Active: true }), mk(C.J, { "Coach Name": "Jo Cover", Active: true }),
    mk(C.M, { "Coach Name": "Mo Manager", Active: true }),
  ];
  W.tables["Sessions"] = [
    mk(S1, { "Session Name": "Main", "Session ID": "SES-ONE", "Session Lifecycle Status": "Active" }),
    mk(S2, { "Session Name": "Second", "Session ID": "SES-TWO", "Session Lifecycle Status": "Active" }),
  ];
  const SS_A = rid("StaffA");
  W.tables["Session Staff"] = [
    mk(SS_A, { Session: [S1], Coach: [C.A], Role: [ROLE.lead], Active: true, "Effective From": "2026-01-01" }),
    mk(rid("StaffL"), { Session: [S1], Coach: [C.L], Role: [ROLE.learn], Active: true, "Effective From": "2026-01-01" }),
    mk(rid("StaffB"), { Session: [S2], Coach: [C.B], Role: [ROLE.coach], Active: true, "Effective From": "2026-01-01" }),
  ];
  const OCC = rid("OccToday");
  W.tables["Session Occurrences"] = [mk(OCC, { Session: [S1], Date: TODAY, Status: "Scheduled" })];
  // Date-specific cover: Jo replaces Alex on S1 today only.
  W.tables["Occurrence Staff"] = [mk(rid("OccStaffJ"), { "Session Occurrence": [OCC], Coach: [C.J], "Assignment Type": "Cover", "Session Staff Source": [SS_A], "Planned Role Snapshot": "Lead Coach" })];
  W.tables["Players"] = [
    mk(P.one, { "Player Name": "Pat One", "Player ID": "PLY-1", "Date of Birth": "2016-01-01" }),
    mk(P.two, { "Player Name": "Sam Two", "Player ID": "PLY-2", "Date of Birth": "2016-02-02" }),
    mk(P.three, { "Player Name": "Kit Three", "Player ID": "PLY-3", "Date of Birth": "2016-03-03" }),
  ];
  W.tables["Player Session Links"] = [
    mk(rid("PslOne"), { Player: [P.one], Session: [S1], "Membership Lifecycle Status": "Active" }),
    mk(rid("PslTwo"), { Player: [P.two], Session: [S2], "Membership Lifecycle Status": "Active" }),
    // Former player: ended 5 days ago with Alex captured at the end.
    mk(rid("PslThree"), { Player: [P.three], Session: [S1], "Membership Lifecycle Status": "Ended", "LEGACY — Coaches At End": [C.A], "LEGACY — End Date": daysAgo(5) }),
  ];
  W.tables["Feature Controls"] = [];
  W.tables["Parents & Guardians"] = [mk(PARENT_REC, { "Parent / Guardian Name": "Pip Parent", "Parent ID": "PARENT-TEST-P1", Email: "pip@test.invalid", "Supabase User ID": U.parent, Active: true })];
  W.tables["Parent–Player Links"] = [
    mk(LINK_VERIFIED, { "Link ID": "PPLINK-V", "Parent / Guardian": [PARENT_REC], Player: [P.one], "Link Lifecycle Status": "Verified" }),
    mk(LINK_PENDING, { "Link ID": "PPLINK-P", "Parent / Guardian": [PARENT_REC], Player: [P.two], "Link Lifecycle Status": "Pending" }),
  ];
  for (const t of ["Venues", "Feedback", "Feedback Ratings", "Development Framework", "Settings", "Player Session Requests"]) W.tables[t] = [];
  const prof = (user_id: string, role: string, airtable_person_id: string | null, active = true): Profile => ({ user_id, role, active, organisation_id: ORG, airtable_person_id, display_name: null });
  W.profiles = [
    prof(U.mgmt, "management", C.M), prof(U.parent, "parent", PARENT_REC), prof(U.coachA, "coach", C.A), prof(U.coachB, "coach", C.B),
    prof(U.learn, "coach", C.L), prof(U.cover, "coach", C.J), prof(U.fresh, "parent", null), prof(U.dupe, "parent", null), prof(U.other, "parent", null),
  ];
  const tok: Record<string, string> = { mgmt: U.mgmt, parent: U.parent, coachA: U.coachA, coachB: U.coachB, learn: U.learn, cover: U.cover, fresh: U.fresh, dupe: U.dupe, other: U.other };
  for (const [t, id] of Object.entries(tok)) W.users[`tok-${t}`] = { id, email: `${t}@test.invalid` };
  W.users["tok-noprofile"] = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "noprofile@test.invalid" };
}
const setActive = (userId: string, active: boolean) => { W.profiles.find((p) => p.user_id === userId)!.active = active; };
const parentRows = () => table("Parents & Guardians");
const snapshot = () => JSON.stringify({ links: table("Parent–Player Links"), psl: table("Player Session Links"), players: table("Players") });

// ---------------------------------------------------------------------
(async () => {
  const PH = await boot("parent-hub", ["index.ts", "parent-identity.ts"], false);
  const PH_BASE = await boot("parent-hub", ["index.ts"], true);
  const HC = await boot("hub-content", ["index.ts", "player-access.ts"], false);
  const HC_BASE = await boot("hub-content", ["index.ts", "player-access.ts"], true);
  ck("H0. Real parent-hub and hub-content (current + b24dc60) bundle and boot with the stubs", !!PH && !!PH_BASE && !!HC && !!HC_BASE);
  ck("H1. hub-content/player-access.ts is byte-identical to b24dc60 (Session Staff / cover / former logic untouched)",
    readFileSync(join(FUNCS, "hub-content/player-access.ts"), "utf8") === execFileSync("git", ["show", `${BASELINE}:supabase/functions-test/hub-content/player-access.ts`], { cwd: ROOT, encoding: "utf8" }));

  // ===================== P1-1 parent-hub =====================
  const same = async (method: string, path: string, token: string, body?: unknown, prep?: () => void) => {
    seed(); prep?.(); const a = await call(PH, "parent-hub", method, path, token, body); const aState = snapshot();
    seed(); prep?.(); const b = await call(PH_BASE, "parent-hub", method, path, token, body); const bState = snapshot();
    return { a, b, equal: a.status === b.status && a.text === b.text && aState === bState };
  };
  {
    const me = await same("GET", "me", "tok-parent");
    const pending = await same("GET", "claims/pending", "tok-mgmt");
    const approve = await same("POST", `claims/${LINK_PENDING}/approve`, "tok-mgmt", {});
    const reject = await same("POST", `claims/${LINK_PENDING}/reject`, "tok-mgmt", { note: "no" });
    ck("1. Active Management: claims/pending, approve and reject behave exactly as b24dc60 (status, body, resulting data)",
      pending.equal && approve.equal && reject.equal && pending.a.status === 200 && approve.a.status === 200 && reject.a.status === 200,
      `${pending.a.status}/${approve.a.status}/${reject.a.status}`);
    ck("2. Active Parent: GET me returns the same payload as b24dc60", me.equal && me.a.status === 200 && Array.isArray(me.a.data.children), `${me.a.status}`);
    const fb = await same("GET", `feedback?player_record_id=${P.one}`, "tok-parent");
    const claim = await same("POST", "claims", "tok-parent", { player_name: "Kit Three", date_of_birth: "2016-03-03" });
    ck("2b. Active Parent: feedback read and a new claim behave as b24dc60 (claim link ids carry a timestamp, so status + shape compared)",
      fb.equal && claim.a.status === claim.b.status && claim.a.text === claim.b.text, `${fb.a.status}/${claim.a.status}`);
    const coachMe = await same("GET", "me", "tok-coachA");
    const coachPending = await same("GET", "claims/pending", "tok-coachA");
    ck("3. Active Coach: still refused parent and Management routes with the same 403s as before", coachMe.equal && coachPending.equal && coachMe.a.status === 403 && coachPending.a.status === 403);

    const denied = async (who: string, uid: string, method: string, path: string, body?: unknown) => {
      seed(); setActive(uid, false);
      const before = snapshot(); const r = await call(PH, "parent-hub", method, path, who, body); const after = snapshot();
      seed(); setActive(uid, false); const old = await call(PH_BASE, "parent-hub", method, path, who, body);
      return { r, old, unchanged: before === after };
    };
    const mPend = await denied("tok-mgmt", U.mgmt, "GET", "claims/pending");
    ck("4. Inactive Management: claims/pending 403 inactive_profile (b24dc60 returned 200)", mPend.r.status === 403 && mPend.r.data.code === "inactive_profile" && mPend.old.status === 200, `${mPend.r.status} vs base ${mPend.old.status}`);
    const pMe = await denied("tok-parent", U.parent, "GET", "me");
    const pFb = await denied("tok-parent", U.parent, "GET", `feedback?player_record_id=${P.one}`);
    const pClaim = await denied("tok-parent", U.parent, "POST", "claims", { player_name: "Kit Three", date_of_birth: "2016-03-03" });
    const pReq = await denied("tok-parent", U.parent, "POST", "session-requests", { player_record_id: P.one, session_record_id: S2 });
    ck("5. Inactive Parent: me, feedback, claims and session-requests all 403 inactive_profile; nothing written",
      [pMe, pFb, pClaim, pReq].every((x) => x.r.status === 403 && x.r.data.code === "inactive_profile" && x.unchanged), [pMe, pFb, pClaim, pReq].map((x) => x.r.status).join("/"));
    const cMe = await denied("tok-coachA", U.coachA, "GET", "me");
    const cPend = await denied("tok-coachA", U.coachA, "GET", "claims/pending");
    ck("6. Inactive Coach: denied with 403 inactive_profile on every route", cMe.r.status === 403 && cPend.r.status === 403 && cMe.r.data.code === "inactive_profile");
    seed();
    const np = await call(PH, "parent-hub", "GET", "me", "tok-noprofile");
    const npBase = await call(PH_BASE, "parent-hub", "GET", "me", "tok-noprofile");
    const noAuth = await call(PH, "parent-hub", "GET", "me");
    ck("7. Missing profile still 401 'Invalid or expired session' exactly as before; no token 401", np.status === 401 && np.text === npBase.text && noAuth.status === 401);
    const ap = await denied("tok-mgmt", U.mgmt, "POST", `claims/${LINK_PENDING}/approve`, {});
    const rj = await denied("tok-mgmt", U.mgmt, "POST", `claims/${LINK_PENDING}/reject`, { note: "x" });
    ck("8. Inactive Management cannot approve or reject a claim (403; link unchanged). b24dc60 approved it", ap.r.status === 403 && rj.r.status === 403 && ap.unchanged && rj.unchanged && ap.old.status === 200,
      `${ap.r.status}/${rj.r.status} base ${ap.old.status}`);
    ck("9. Inactive Parent cannot read parent/player relationship data (me + feedback 403, no children or links in the body)",
      pMe.r.status === 403 && !("children" in (pMe.r.data || {})) && pFb.r.status === 403 && pMe.old.status === 200);
    const all = [mPend, pMe, pFb, pClaim, pReq, cMe, cPend, ap, rj];
    ck("10. Inactive is never treated as anonymous/public: every inactive call is an explicit 403 (not 200, not 401), and no route ran",
      all.every((x) => x.r.status === 403 && x.r.data.error === "This account is not active.") && all.every((x) => x.unchanged));
  }

  // ===================== P1-1 hub-content /players =====================
  {
    const players = async (h: Handler, token?: string) => call(h, "hub-content", "GET", "players", token);
    const both = async (token: string) => { seed(); const a = await players(HC, token); seed(); const b = await players(HC_BASE, token); return { a, b, equal: a.status === b.status && a.text === b.text }; };
    const m = await both("tok-mgmt");
    ck("11. Active Management /players identical to b24dc60 (admin rows for every non-Ended membership)", m.equal && m.a.status === 200 && m.a.data.length === 2 && m.a.data.every((r: any) => r.tier === "admin" && r.can_edit_idp));
    seed(); setActive(U.mgmt, false);
    const mi = await players(HC, "tok-mgmt");
    seed(); setActive(U.mgmt, false);
    const miBase = await players(HC_BASE, "tok-mgmt");
    ck("12. Inactive Management /players 403, no player data (b24dc60 returned every player with admin perms)", mi.status === 403 && !Array.isArray(mi.data) && Array.isArray(miBase.data) && miBase.data.length === 2, `${mi.status} vs base ${miBase.data.length} rows`);
    const a = await both("tok-coachA"), b2 = await both("tok-coachB");
    ck("13. Active Coach permissions unchanged (identical to b24dc60): Bea sees S2 player with Coach perms",
      a.equal && b2.equal && b2.a.data.length === 1 && b2.a.data[0].player_record_id === P.two && b2.a.data[0].can_edit_idp === false && b2.a.data[0].can_edit_feedback === true);
    seed(); setActive(U.coachB, false);
    const bi = await players(HC, "tok-coachB");
    ck("14. Inactive Coach /players 403, no rows", bi.status === 403 && !Array.isArray(bi.data));
    const l = await both("tok-learn");
    ck("15. Learning Coach restriction unchanged: no player rows (same as b24dc60)", l.equal && l.a.status === 200 && l.a.data.length === 0);
    const j = await both("tok-cover");
    ck("16. Date-specific cover unchanged: Jo (cover today) gets the S1 player as Lead; Alex is displaced today (identical to b24dc60)",
      j.equal && j.a.data.length === 1 && j.a.data[0].player_record_id === P.one && j.a.data[0].can_edit_idp === true
      && !a.a.data.some((r: any) => r.player_record_id === P.one));
    ck("17. Former-player access unchanged: Alex keeps Kit (ended 5 days ago) as 'former' until end + 28 days (identical to b24dc60)",
      a.a.data.length === 1 && a.a.data[0].player_record_id === P.three && a.a.data[0].tier === "former");
    seed();
    const anon = await players(HC);
    ck("17b. No session: still 200 [] exactly as before", anon.status === 200 && Array.isArray(anon.data) && anon.data.length === 0);
  }

  // ===================== P1-2 parent identity (real parent-hub) =====================
  {
    seed();
    const r = await call(PH, "parent-hub", "GET", "me", "tok-parent");
    ck("18. Existing unique Parent resolves normally (no create, no lock taken, profile link already set)", r.status === 200 && W.calls.creates === 0 && W.calls.lockAcquires === 0);

    seed();
    const c = await call(PH, "parent-hub", "GET", "me", "tok-fresh");
    const mine = parentRows().filter((x) => x.fields["Supabase User ID"] === U.fresh);
    ck("19. No Parent -> exactly one created, with the deterministic Parent ID, linked on the profile, lock released",
      c.status === 200 && mine.length === 1 && mine[0].fields["Parent ID"] === makeParentId(U.fresh)
      && W.profiles.find((p) => p.user_id === U.fresh)!.airtable_person_id === mine[0].id && W.locks.size === 0);

    // Concurrency: the real router, five first-time requests at once, mixed routes.
    seed();
    W.airtableDelayMs = 6;
    const burst = await Promise.all([
      call(PH, "parent-hub", "GET", "me", "tok-fresh"),
      call(PH, "parent-hub", "GET", "me", "tok-fresh"),
      call(PH, "parent-hub", "POST", "claims", "tok-fresh", { player_name: "Pat One", date_of_birth: "2016-01-01" }),
      call(PH, "parent-hub", "GET", "me", "tok-fresh"),
      call(PH, "parent-hub", "POST", "claims", "tok-fresh", { player_name: "Sam Two", date_of_birth: "2016-02-02" }),
    ]);
    const created = parentRows().filter((x) => x.fields["Supabase User ID"] === U.fresh);
    ck("20. Five simultaneous first-time calls create exactly ONE Parent (all succeed)", created.length === 1 && W.calls.creates === 1 && burst.every((x) => x.status === 200), burst.map((x) => x.status).join("/"));
    const claimLinks = table("Parent–Player Links").filter((l) => l.fields["Signup Source"] === "Parent signup");
    ck("21. Every caller resolved the same Parent (both claims hang off that one record)", claimLinks.length === 2 && claimLinks.every((l) => l.fields["Parent / Guardian"][0] === created[0].id));
    const ids = parentRows().map((x) => x.fields["Parent ID"]);
    ck("22. No duplicate Parent ID anywhere", new Set(ids).size === ids.length);
    const uids = parentRows().map((x) => x.fields["Supabase User ID"]).filter(Boolean);
    ck("23. No duplicate Supabase User ID mapping; profile link equals the one record", new Set(uids).size === uids.length && W.profiles.find((p) => p.user_id === U.fresh)!.airtable_person_id === created[0].id);

    // Same burst on the b24dc60 code: proves the race was real.
    seed();
    W.airtableDelayMs = 6;
    await Promise.all([call(PH_BASE, "parent-hub", "GET", "me", "tok-fresh"), call(PH_BASE, "parent-hub", "POST", "claims", "tok-fresh", { player_name: "Pat One", date_of_birth: "2016-01-01" })]);
    const baseDupes = parentRows().filter((x) => x.fields["Supabase User ID"] === U.fresh).length;
    ck("20b. Control: the same two simultaneous calls on b24dc60 create duplicate Parents (the audited race)", baseDupes === 2, `${baseDupes} rows`);
  }

  // ===================== P1-2 parent identity (module level) =====================
  {
    // Direct deps over the same in-memory world (no router).
    const at = async (path: string, init: RequestInit = {}) => (await fetch(`https://api.airtable.com/v0/appQktredAuGa1X7e/${TBL_PARENTS}${path}`, init));
    const find = async (field: string, value: string) => (await (await at(`?filterByFormula=${encodeURIComponent(`{${field}} = "${value}"`)}`)).json()).records;
    const deps = (over: Partial<ParentIdentityDeps> = {}): ParentIdentityDeps => ({
      parents: {
        findByUserId: (u) => find("Supabase User ID", u),
        findByEmail: (e) => find("Email", e),
        findByParentId: (p) => find("Parent ID", p),
        get: async (id) => { const r = await at(`/${id}`); if (r.status === 404) return null; if (!r.ok) throw new Error("x"); return r.json(); },
        create: async (fields) => { const r = await at("", { method: "POST", body: JSON.stringify({ records: [{ fields }] }) }); if (!r.ok) throw new Error(`Airtable create error: ${r.status}`); return (await r.json()).records[0]; },
        setUserId: async (id, u) => { await at(`/${id}`, { method: "PATCH", body: JSON.stringify({ fields: { "Supabase User ID": u } }) }); },
      },
      profiles: {
        read: async (u) => W.profiles.find((p) => p.user_id === u)?.airtable_person_id ?? null,
        fillIfEmpty: async (u, id) => { const p = W.profiles.find((x) => x.user_id === u)!; if (p.airtable_person_id == null) p.airtable_person_id = id; return p.airtable_person_id; },
      },
      lock: {
        acquire: async (o, u) => { W.calls.lockAcquires++; const k = `${o}|${u}`; if (W.locks.has(k)) return null; const t = crypto.randomUUID(); W.locks.set(k, t); return t; },
        release: async (o, u, t) => { W.calls.lockReleases++; if (W.faults.releaseFail > 0) { W.faults.releaseFail--; throw new Error("release boom"); } const k = `${o}|${u}`; if (W.locks.get(k) === t) { W.locks.delete(k); return true; } return false; },
      },
      sleep: (ms) => sleep(ms), lockIntervalMs: 5, lockAttempts: 200,
      ...over,
    });
    const caller = (u: string, email = "", organisationId = ORG) => ({ userId: u, email, organisationId });
    const err = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e as any; } };

    // 24: email compatibility path, as before: one unowned row with this email is adopted.
    seed();
    table("Parents & Guardians").push({ id: rid("LegacyMail"), createdTime: "2026-01-01T00:00:00.000Z", fields: { "Parent ID": "PARENT-LEGACY", Email: "fresh@test.invalid", Active: true } });
    const adopted = await resolveParentIdentity(deps(), caller(U.fresh, "fresh@test.invalid"));
    ck("24. Email compatibility unchanged: the single unowned row with this email is adopted (user id written, no new record)",
      adopted.id === rid("LegacyMail") && W.calls.creates === 0 && parentRows().find((x) => x.id === rid("LegacyMail"))!.fields["Supabase User ID"] === U.fresh);

    // 25: user-id match wins over an email match.
    seed();
    table("Parents & Guardians").push({ id: rid("MailOnly"), createdTime: "2026-01-01T00:00:00.000Z", fields: { "Parent ID": "PARENT-MAIL", Email: "pip@test.invalid", Active: true } });
    W.profiles.find((p) => p.user_id === U.parent)!.airtable_person_id = null;
    const won = await resolveParentIdentity(deps(), caller(U.parent, "pip@test.invalid"));
    ck("25. Supabase User ID match wins over email fallback (email-only row untouched)", won.id === PARENT_REC && !parentRows().find((x) => x.id === rid("MailOnly"))!.fields["Supabase User ID"]);

    // 26/27: duplicates for one user -> parent_id_ambiguous, never array[0].
    seed();
    const dA = rid("DupeA"), dB = rid("DupeB");
    table("Parents & Guardians").push(
      { id: dA, createdTime: "2026-09-26T16:59:59.000Z", fields: { "Parent ID": makeParentId(U.dupe), "Supabase User ID": U.dupe, Email: "dupe@test.invalid", Active: true } },
      { id: dB, createdTime: "2026-09-26T16:59:59.000Z", fields: { "Parent ID": makeParentId(U.dupe), "Supabase User ID": U.dupe, Email: "dupe@test.invalid", Active: true } },
    );
    const e26 = await err(resolveParentIdentity(deps(), caller(U.dupe, "dupe@test.invalid")));
    ck("26. Two Parent rows for one user -> parent_id_ambiguous (409), nothing created, profile link left empty",
      e26 instanceof ParentIdentityError && e26.code === "parent_id_ambiguous" && e26.status === 409 && W.calls.creates === 0 && W.profiles.find((p) => p.user_id === U.dupe)!.airtable_person_id === null);
    const viaRoute = await call(PH, "parent-hub", "GET", "me", "tok-dupe");
    const viaRouteBase = await call(PH_BASE, "parent-hub", "GET", "me", "tok-dupe");
    ck("27. Ambiguity never uses array[0]: the real /me answers 409 parent_id_ambiguous with no child data (b24dc60 answered 200 from the first row)",
      viaRoute.status === 409 && viaRoute.data.code === "parent_id_ambiguous" && !("children" in viaRoute.data) && viaRouteBase.status === 200);
    // Profile link pointing at one duplicate does not make the other disappear.
    W.profiles.find((p) => p.user_id === U.dupe)!.airtable_person_id = dA;
    const e27b = await err(resolveParentIdentity(deps(), caller(U.dupe)));
    ck("27b. Even with the profile linked to one duplicate, the other still makes it ambiguous", e27b?.code === "parent_id_ambiguous");

    // 28: identity resolution never touches links / memberships / players.
    seed();
    const before = snapshot();
    await resolveParentIdentity(deps(), caller(U.fresh, "fresh@test.invalid"));
    await resolveParentIdentity(deps(), caller(U.parent, "pip@test.invalid"));
    await err(resolveParentIdentity(deps(), caller(U.dupe)));
    ck("28. No child / link / membership history changed by identity resolution", snapshot() === before);

    // 29: cross-user claims.
    seed();
    table("Parents & Guardians").push({ id: rid("Owned"), createdTime: "2026-01-01T00:00:00.000Z", fields: { "Parent ID": "PARENT-OWNED", Email: "shared@test.invalid", "Supabase User ID": U.other, Active: true } });
    const e29 = await err(resolveParentIdentity(deps(), caller(U.fresh, "shared@test.invalid")));
    ck("29a. An email-matched row owned by ANOTHER user is never taken over (parent_id_ambiguous; owner unchanged; nothing created)",
      e29?.code === "parent_id_ambiguous" && parentRows().find((x) => x.id === rid("Owned"))!.fields["Supabase User ID"] === U.other && W.calls.creates === 0);
    W.profiles.find((p) => p.user_id === U.fresh)!.airtable_person_id = PARENT_REC;
    const e29b = await err(resolveParentIdentity(deps(), caller(U.fresh)));
    ck("29b. A profile link pointing at another user's Parent is refused (profile_link_mismatch -> parent_id_ambiguous)", e29b?.code === "parent_id_ambiguous" && e29b.reason === "profile_link_mismatch");

    // 30: organisation scoping of the serialisation.
    seed();
    const e30 = await err(resolveParentIdentity(deps(), caller(U.fresh, "", "")));
    W.locks.set(`ORG-OTHER|${U.fresh}`, "held-elsewhere");
    const r30 = await resolveParentIdentity(deps(), caller(U.fresh, "", ORG));
    ck("30. Lock is keyed by organisation + user: no organisation -> refused (organisation_missing); another org's lock does not serialise or leak into this org; Parent rows are matched by the caller's own Supabase user id only",
      e30?.code === "organisation_missing" && r30.fields["Supabase User ID"] === U.fresh && W.locks.get(`ORG-OTHER|${U.fresh}`) === "held-elsewhere" && !W.locks.has(`${ORG}|${U.fresh}`));

    // 31/32: failed create; lock released; safe retry.
    seed();
    W.faults.createFailBeforeWrite = 1;
    const e31 = await err(resolveParentIdentity(deps(), caller(U.fresh)));
    const lockFreeAfterFail = W.locks.size === 0;
    const retry = await resolveParentIdentity(deps(), caller(U.fresh));
    ck("31. Create fails cleanly -> error surfaces, nothing half-written; retry creates exactly one",
      !!e31 && !(e31 instanceof ParentIdentityError) && parentRows().filter((x) => x.fields["Supabase User ID"] === U.fresh).length === 1 && retry.fields["Supabase User ID"] === U.fresh);
    seed();
    W.faults.releaseFail = 1;
    const r32 = await resolveParentIdentity(deps({ log: () => {} }), caller(U.fresh));
    const stuck = W.locks.size;
    ck("32. Lock released after a failure (31) and after success; a failing release never fails the request (stale lock then expires: 2-minute TTL in SQL)",
      lockFreeAfterFail && r32.fields["Supabase User ID"] === U.fresh && stuck === 1);

    // 33: ambiguous provider failure: create landed but reported an error.
    seed();
    W.faults.createFailAfterWrite = 1;
    const r33 = await resolveParentIdentity(deps(), caller(U.fresh)).catch(() => ({ id: "ERR", fields: {} }) as ParentRecord);
    const again33 = await resolveParentIdentity(deps(), caller(U.fresh)).catch(() => ({ id: "ERR2", fields: {} }) as ParentRecord);
    ck("33. Create that lands but reports failure is recovered inside the lock (re-read), linked, and a retry reuses it: one record, one create call",
      r33.fields["Supabase User ID"] === U.fresh && again33.id === r33.id && W.calls.creates === 1 && parentRows().filter((x) => x.fields["Supabase User ID"] === U.fresh).length === 1
      && W.profiles.find((p) => p.user_id === U.fresh)!.airtable_person_id === r33.id);

    // Extra: a waiter whose lock never frees gets a retryable 409, not a create.
    seed();
    W.locks.set(`${ORG}|${U.fresh}`, "someone-else");
    const busy = await err(resolveParentIdentity(deps({ lockAttempts: 3 }), caller(U.fresh)));
    ck("34. Lock held elsewhere for too long -> parent_identity_busy (409), no create", busy?.code === "parent_identity_busy" && busy.status === 409 && W.calls.creates === 0);

    // Extra: many concurrent module-level calls, varied timings.
    seed();
    const many = await Promise.all(Array.from({ length: 12 }, (_, i) => (async () => { await sleep(i % 4); return resolveParentIdentity(deps(), caller(U.fresh, "fresh@test.invalid")).catch((e) => ({ id: `ERR:${e.message}`, fields: {} }) as ParentRecord); })()));
    ck("35. Twelve concurrent first-time resolutions: one record, every caller gets the same id",
      new Set(many.map((m) => m.id)).size === 1 && W.calls.creates === 1 && parentRows().filter((x) => x.fields["Supabase User ID"] === U.fresh).length === 1);
  }

  // ===================== Drift / scope guards =====================
  {
    const ph = readFileSync(join(FUNCS, "parent-hub/index.ts"), "utf8");
    const hc = readFileSync(join(FUNCS, "hub-content/index.ts"), "utf8");
    const creates = ph.match(/createAirtableRecord\(TBL_PARENTS/g) || [];
    ck("D1. parent-hub: no byUserId[0] pick; the only Parent create is the one handed to resolveParentIdentity (behind the lock)",
      !/byUserId\[0\]/.test(ph) && creates.length === 1 && ph.includes("create: (fields) => createAirtableRecord(TBL_PARENTS, fields)") && !/function ensureUniqueParentId/.test(ph));
    ck("D2. parent-hub's single active gate sits before the route table", ph.indexOf('if (!caller.active) return jsonResponse({ error: "This account is not active.", code: "inactive_profile" }, 403);') > 0
      && ph.indexOf('if (!caller.active)') < ph.indexOf('if (route === "me"'));
    ck("D3. hub-content: only index.ts changed; /players gate present", /if \(caller && !caller\.active\) return jsonResponse\(\{ error: "Forbidden" \}, 403\);/.test(hc));
  }

  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
  console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
