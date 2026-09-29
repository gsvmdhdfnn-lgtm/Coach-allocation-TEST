/**
 * Schedule prerequisite before Finance F5 - Session Occurrence delivery
 * confirmation writer ("Went as planned" / "Something changed").
 * Run: node --experimental-strip-types tests/support/occurrence-confirmation.test.ts
 *
 *   AC  access (Management only, Coach / Parent / inactive / unauthenticated route guard, tenant keys, org from profile)
 *   WP  went as planned (state written, stamps, no exception, identical repeat = no-op)
 *   SC  something changed (delivered yes / no, reason validation, structured result, free text never delivery truth)
 *   IT  invalid transitions (future, cancelled, postponed, completed-unconfirmed, other confirmation, bad values, bad data)
 *   HI  history (actor / time / before / after, rejected writes and no-op repeats write nothing, one PATCH)
 *   LK  lock (generation lock per Session, held -> busy, always released, re-read under the lock)
 *   F4  Finance F4 integration (the written facts resolve through the UNCHANGED finance-billing.ts)
 *   Z   code / drift checks against the canonical session-occurrences files
 *
 * The fetch mock IGNORES filterByFormula on purpose: the repository must
 * re-check every row's Occurrence ID in code.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXCEPTION_REASONS,
  OCC_FIELDS,
  type ConfirmRequest,
  decide,
  hasPassed,
  isManagementCaller,
  occurrenceState,
  parseConfirmBody,
  resolveOrganisation,
  todayIn,
} from "./occurrence-confirmation.ts";
import { CONFIRMATION_RETRY_DELAYS_MS } from "./confirmation-repository.ts";
import { type ConfirmationCaller, type ConfirmationDeps, confirmOccurrence } from "./confirmation-orchestrator.ts";
import type { LockClient } from "./lock-client.ts";
import { type ServiceContext, resolveOccurrenceBilling } from "./finance-billing.ts";
import { occurrenceFacts } from "./finance-billing-mapping.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CANON = join(HERE, "..", "..", "supabase", "functions-test", "session-occurrences");
const FINANCE_CANON = join(HERE, "..", "..", "supabase", "functions-test", "finance");

const R: [string, string, string?][] = [];
let failed = 0;
function ck(name: string, cond: unknown, extra?: string) {
  const ok = !!cond;
  if (!ok) failed++;
  R.push([ok ? "PASS" : "FAIL", name, extra]);
}

CONFIRMATION_RETRY_DELAYS_MS.splice(0, CONFIRMATION_RETRY_DELAYS_MS.length, 0, 0);

const ORG = "ORG-TEST-001";
const SESSION_REC = "recSessionAAAAAAA";
const MGR: ConfirmationCaller = { userId: "285f819e-e0d4-4257-8121-5f16781e97ba", role: "management", active: true, organisationId: ORG, displayName: "Morgan Manager" };
const NOW = new Date("2026-09-29T20:00:00.000Z"); // 21:00 in Europe/London
const ORG_ROW = { id: "recOrgRowAAAAAAAA", fields: { "Organisation ID": ORG, "Organisation Name": "Test Org", Timezone: "Europe/London", Active: true } };

// ---------------------------------------------------------------------------
// Airtable + lock mocks
// ---------------------------------------------------------------------------
type Row = { id: string; fields: Record<string, any> };
let occurrences: Row[] = [];
let orgs: Row[] = [];
let calls: { method: string; url: string; body?: any }[] = [];
let failPatch = false;
let failRead = false;
let onRead: (() => void) | null = null;

function occ(date: string, over: Record<string, any> = {}, id?: string): Row {
  return {
    id: id ?? `recOcc${date.replace(/-/g, "")}AAA`.slice(0, 17),
    fields: {
      [OCC_FIELDS.id]: `${SESSION_REC}:${date}`,
      [OCC_FIELDS.session]: [SESSION_REC],
      [OCC_FIELDS.date]: date,
      [OCC_FIELDS.start]: `${date}T14:30:00.000Z`,
      [OCC_FIELDS.end]: `${date}T15:30:00.000Z`,
      [OCC_FIELDS.status]: "Scheduled",
      ...over,
    },
  };
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(init.body) : undefined;
  calls.push({ method, url, body });
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  if (url.includes(encodeURIComponent("Organisation & Branding"))) return json(200, { records: orgs });
  if (url.includes(encodeURIComponent("Session Occurrences"))) {
    if (method === "GET") {
      if (failRead) return json(500, { error: "boom" });
      if (onRead) onRead();
      return json(200, { records: occurrences.map((r) => ({ id: r.id, fields: { ...r.fields } })) });
    }
    if (method === "PATCH") {
      if (failPatch) return json(500, { error: "boom" });
      const id = url.split("/").pop()!;
      const row = occurrences.find((r) => r.id === id);
      if (!row) return json(404, { error: "NOT_FOUND" });
      for (const [k, v] of Object.entries(body.fields)) {
        if (v === null) delete row.fields[k];
        else row.fields[k] = v;
      }
      return json(200, { id: row.id, fields: row.fields });
    }
  }
  return json(404, { error: `unmocked ${method} ${url}` });
}) as typeof fetch;

let lockHeld: Map<string, string>;
let lockEvents: string[];
let lockMode: "ok" | "busy" | "error";
function lockClient(): LockClient {
  let seq = 0;
  return {
    async acquire(key: string) {
      if (lockMode === "error") throw new Error("lock rpc down");
      if (lockMode === "busy" || lockHeld.has(key)) return null;
      const t = `tok-${++seq}`;
      lockHeld.set(key, t);
      lockEvents.push(`acquire:${key}`);
      return t;
    },
    async release(key: string, token: string) {
      lockEvents.push(`release:${key}`);
      if (lockHeld.get(key) === token) {
        lockHeld.delete(key);
        return true;
      }
      return false;
    },
  };
}

function reset(rows: Row[] = []) {
  occurrences = rows;
  orgs = [ORG_ROW];
  calls = [];
  failPatch = false;
  failRead = false;
  onRead = null;
  lockHeld = new Map();
  lockEvents = [];
  lockMode = "ok";
}
const deps = (): ConfirmationDeps => ({ airtable: { baseId: "appQktredAuGa1X7e", token: "t" }, lock: lockClient(), clock: () => NOW, lockAttempts: 2, lockRetryDelayMs: 0 });
const patches = () => calls.filter((c) => c.method === "PATCH");
const req = (occurrenceId: string, body: Record<string, unknown>): ConfirmRequest => {
  const p = parseConfirmBody(JSON.stringify({ occurrenceId, ...body }));
  if (!p.ok) throw new Error(`bad test request: ${p.error}`);
  return p.req;
};
const WENT = { confirmation: "went_as_planned" };
const CHANGED_YES = { confirmation: "something_changed", delivered: true, exceptionReason: "Staffing" };
const CHANGED_NO = { confirmation: "something_changed", delivered: false, exceptionReason: "Weather" };
const f = (id: string) => (occurrences.find((r) => r.id === id) as Row).fields;

async function main() {
  // =========================================================================
  // AC - access
  // =========================================================================
  {
    const id = `${SESSION_REC}:2026-09-10`;
    for (const [label, caller] of [
      ["Coach", { ...MGR, role: "coach" }],
      ["Parent", { ...MGR, role: "parent" }],
      ["inactive Management", { ...MGR, active: false }],
      ["no role (pending)", { ...MGR, role: null }],
    ] as [string, ConfirmationCaller][]) {
      reset([occ("2026-09-10")]);
      const r = await confirmOccurrence(deps(), caller, req(id, WENT));
      ck(`AC ${label} is refused 403 management_required and nothing is read or written`, r.status === "error" && r.httpStatus === 403 && r.code === "management_required" && calls.length === 0 && lockEvents.length === 0, JSON.stringify(r));
    }
    reset([occ("2026-09-10")]);
    const ok = await confirmOccurrence(deps(), MGR, req(id, WENT));
    ck("AC active Management is allowed", ok.status === "ok" && ok.httpStatus === 200, JSON.stringify(ok));
    ck("AC isManagementCaller: only role management + active", isManagementCaller({ role: "management", active: true }) && !isManagementCaller({ role: "management", active: false }) && !isManagementCaller({ role: "coach", active: true }) && !isManagementCaller({ role: "parent", active: true }));

    for (const key of ["organisationId", "organisation", "tenant", "orgId", "baseId", "ORGANISATION_ID"]) {
      const p = parseConfirmBody(JSON.stringify({ occurrenceId: id, confirmation: "went_as_planned", [key]: "ORG-OTHER" }));
      ck(`AC tenant key "${key}" in the body is rejected 400 tenant_param_rejected (never ignored)`, !p.ok && p.code === "tenant_param_rejected");
    }
    reset([occ("2026-09-10")]);
    const noOrg = await confirmOccurrence(deps(), { ...MGR, organisationId: null }, req(id, WENT));
    ck("AC a profile with no organisation is refused 409 and nothing is written", noOrg.status === "error" && noOrg.httpStatus === 409 && noOrg.code === "organisation_not_found" && patches().length === 0);
    reset([occ("2026-09-10")]);
    const otherOrg = await confirmOccurrence(deps(), { ...MGR, organisationId: "ORG-OTHER-999" }, req(id, WENT));
    ck("AC the organisation is the caller's own profile organisation (another id does not resolve)", otherOrg.status === "error" && otherOrg.code === "organisation_not_found" && patches().length === 0);
    reset([occ("2026-09-10")]);
    orgs = [ORG_ROW, { ...ORG_ROW, id: "recOrgRowBBBBBBBB" }];
    const amb = await confirmOccurrence(deps(), MGR, req(id, WENT));
    ck("AC two active organisation rows for the profile org -> 409 organisation_ambiguous", amb.status === "error" && amb.code === "organisation_ambiguous" && patches().length === 0);

    const idx = readFileSync(join(CANON, "index.ts"), "utf8");
    const handler = idx.slice(idx.indexOf("async function handleConfirmOccurrence"), idx.indexOf("Deno.serve("));
    ck("AC route: unauthenticated -> 401 before anything else", /if \(!caller\) return jsonResponse\(\{ error: "Missing or invalid Authorization header" \}, 401\)/.test(handler) && handler.indexOf("401") < handler.indexOf("403"));
    ck("AC route: non-Management / inactive -> 403 before the body is read", /if \(!caller\.active \|\| caller\.role !== "management"\)/.test(handler) && handler.indexOf("403") < handler.indexOf("parseConfirmBody"));
    ck("AC route: query parameters refused, POST only", /searchParams\.keys\(\)\]\.length\) return jsonResponse/.test(handler) && /route === "confirm-occurrence"\) \{\s*if \(req\.method !== "POST"\)/.test(idx));
    ck("AC route: organisation comes from the profile's organisation_id only", /select\("role, airtable_person_id, active, display_name, organisation_id"\)/.test(idx) && !/body\?\.organisation/i.test(handler));
    ck("AC production guard still present", idx.includes("apprptFotQuVL1mhs") && idx.includes("TEST function refusing to start"));
  }

  // =========================================================================
  // WP - went as planned
  // =========================================================================
  {
    reset([occ("2026-09-10", { [OCC_FIELDS.confirmation]: "Awaiting Confirmation", "Operational Notes": "Coach ran it fine" })]);
    const rid = occurrences[0].id;
    const r = await confirmOccurrence(deps(), MGR, req(`${SESSION_REC}:2026-09-10`, WENT));
    const b = (r as any).body;
    ck("WP a passed occurrence is confirmed (200, changed true)", r.status === "ok" && b.changed === true, JSON.stringify(r));
    ck("WP Confirmation State = Confirmed", f(rid)[OCC_FIELDS.confirmation] === "Confirmed");
    ck("WP Status = Completed (delivered)", f(rid)[OCC_FIELDS.status] === "Completed");
    ck("WP no exception created (no Exception Reason / Exception At written)", !(OCC_FIELDS.exceptionReason in patches()[0].body.fields) && !(OCC_FIELDS.exceptionAt in patches()[0].body.fields) && f(rid)[OCC_FIELDS.exceptionReason] === undefined);
    ck("WP no exception reason required", parseConfirmBody(JSON.stringify({ occurrenceId: "x:1", confirmation: "went_as_planned" })).ok);
    ck("WP unrelated fields untouched (only the 5 confirmation fields are sent)", JSON.stringify(Object.keys(patches()[0].body.fields).sort()) === JSON.stringify([OCC_FIELDS.confirmedAt, OCC_FIELDS.confirmedByName, OCC_FIELDS.confirmedBy, OCC_FIELDS.confirmation, OCC_FIELDS.status].sort()) && f(rid)["Operational Notes"] === "Coach ran it fine");
    ck("WP response: public view, no Airtable record id", b.occurrence.confirmation === "went_as_planned" && b.occurrence.delivered === true && !JSON.stringify(b).includes(rid) && b.contract === "schedule-occurrence-confirmation-v1");
    const n = patches().length;
    const again = await confirmOccurrence(deps(), MGR, req(`${SESSION_REC}:2026-09-10`, WENT));
    ck("WP identical repeat -> 200 changed:false, no second write", again.status === "ok" && (again as any).body.changed === false && patches().length === n, JSON.stringify(again));
    ck("WP identical repeat keeps the original stamps", f(rid)[OCC_FIELDS.confirmedAt] === NOW.toISOString());

    reset([occ("2026-09-10")]); // blank Confirmation State = awaiting too
    const blank = await confirmOccurrence(deps(), MGR, req(`${SESSION_REC}:2026-09-10`, WENT));
    ck("WP blank Confirmation State counts as awaiting and can be confirmed", blank.status === "ok" && f(occurrences[0].id)[OCC_FIELDS.confirmation] === "Confirmed");
  }

  // =========================================================================
  // SC - something changed
  // =========================================================================
  {
    reset([occ("2026-09-11")]);
    const rid = occurrences[0].id;
    const r = await confirmOccurrence(deps(), MGR, req(`${SESSION_REC}:2026-09-11`, CHANGED_YES));
    ck("SC delivered yes -> Exception Recorded + Status Completed", r.status === "ok" && f(rid)[OCC_FIELDS.confirmation] === "Exception Recorded" && f(rid)[OCC_FIELDS.status] === "Completed", JSON.stringify(r));
    ck("SC reason retained + Exception At stamped", f(rid)[OCC_FIELDS.exceptionReason] === "Staffing" && f(rid)[OCC_FIELDS.exceptionAt] === NOW.toISOString());
    ck("SC response states the structured result", (r as any).body.occurrence.confirmation === "something_changed" && (r as any).body.occurrence.delivered === true && (r as any).body.occurrence.exceptionReason === "Staffing");

    reset([occ("2026-09-12")]);
    const rid2 = occurrences[0].id;
    const r2 = await confirmOccurrence(deps(), MGR, req(`${SESSION_REC}:2026-09-12`, CHANGED_NO));
    ck("SC delivered no -> Exception Recorded + Status Cancelled (did not run)", r2.status === "ok" && f(rid2)[OCC_FIELDS.confirmation] === "Exception Recorded" && f(rid2)[OCC_FIELDS.status] === "Cancelled" && f(rid2)[OCC_FIELDS.exceptionReason] === "Weather");
    ck("SC delivered no response: delivered false", (r2 as any).body.occurrence.delivered === false);

    const bad = (body: Record<string, unknown>) => parseConfirmBody(JSON.stringify({ occurrenceId: "recX:2026-09-11", ...body }));
    ck("SC reason required", !bad({ confirmation: "something_changed", delivered: true }).ok);
    ck("SC reason must be an existing Exception Reason choice", !bad({ confirmation: "something_changed", delivered: true, exceptionReason: "Rain" }).ok && !bad({ confirmation: "something_changed", delivered: true, exceptionReason: "weather" }).ok);
    ck("SC every existing Exception Reason choice is accepted", EXCEPTION_REASONS.every((x) => bad({ confirmation: "something_changed", delivered: false, exceptionReason: x }).ok));
    ck("SC delivered required and must be a boolean (no guessing)", !bad({ confirmation: "something_changed", exceptionReason: "Venue" }).ok && !bad({ confirmation: "something_changed", delivered: "yes", exceptionReason: "Venue" }).ok && !bad({ confirmation: "something_changed", delivered: null, exceptionReason: "Venue" }).ok);
    ck("SC free text is not a parameter: a 'notes'/'delivery' text field is refused", !bad({ confirmation: "something_changed", delivered: true, exceptionReason: "Other", notes: "delivered" }).ok && !bad({ confirmation: "went_as_planned", delivery: "Delivered in full" }).ok);

    // Free text never delivery truth: notes say "delivered", no structured answer -> nothing changes, F4 still unresolved/awaiting.
    reset([occ("2026-09-13", { "Operational Notes": "Delivered in full" })]);
    const st = occurrenceState(occurrences[0]);
    ck("SC notes saying 'Delivered in full' do not make the occurrence confirmed or delivered", st.confirmationState === null && st.status === "Scheduled");
    const src = readFileSync(join(CANON, "occurrence-confirmation.ts"), "utf8");
    ck("SC the writer never reads Operational Notes (or any free-text field)", !/Operational Notes|Notes"\]/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")));
  }

  // =========================================================================
  // IT - invalid transitions
  // =========================================================================
  {
    const one = async (row: Row, body: Record<string, unknown>) => {
      reset([row]);
      return confirmOccurrence(deps(), MGR, req(row.fields[OCC_FIELDS.id], body));
    };
    const future = await one(occ("2026-10-15"), WENT);
    ck("IT future occurrence refused 409 occurrence_not_passed, nothing written", future.status === "error" && future.code === "occurrence_not_passed" && patches().length === 0);
    const futureChanged = await one(occ("2026-10-15"), CHANGED_YES);
    ck("IT future occurrence cannot be confirmed as 'something changed, delivered' either", futureChanged.status === "error" && futureChanged.code === "occurrence_not_passed");
    const later = await one(occ("2026-09-29", { [OCC_FIELDS.start]: "2026-09-29T20:30:00.000Z", [OCC_FIELDS.end]: "2026-09-29T21:30:00.000Z" }), WENT);
    ck("IT later today (not yet ended) refused", later.status === "error" && later.code === "occurrence_not_passed");
    const running = await one(occ("2026-09-29", { [OCC_FIELDS.start]: "2026-09-29T19:30:00.000Z", [OCC_FIELDS.end]: "2026-09-29T20:30:00.000Z" }), WENT);
    ck("IT still running (started, not ended) refused - End time decides", running.status === "error" && running.code === "occurrence_not_passed");
    const cancelled = await one(occ("2026-09-10", { [OCC_FIELDS.status]: "Cancelled" }), WENT);
    ck("IT cancelled occurrence cannot be marked went as planned (409, 'did not run')", cancelled.status === "error" && cancelled.code === "occurrence_not_confirmable" && cancelled.error.includes("cancelled occurrence") && patches().length === 0);
    const cancelledChanged = await one(occ("2026-09-10", { [OCC_FIELDS.status]: "Cancelled" }), CHANGED_YES);
    ck("IT cancelled occurrence cannot be confirmed through the normal route at all", cancelledChanged.status === "error" && cancelledChanged.code === "occurrence_not_confirmable");
    const postponed = await one(occ("2026-09-10", { [OCC_FIELDS.status]: "Postponed" }), WENT);
    ck("IT postponed occurrence cannot be marked went as planned (409, 'did not run')", postponed.status === "error" && postponed.code === "occurrence_not_confirmable" && postponed.error.includes("postponed occurrence") && patches().length === 0);
    const completedUnconfirmed = await one(occ("2026-09-10", { [OCC_FIELDS.status]: "Completed" }), WENT);
    ck("IT Completed-but-unconfirmed (not produced by any normal flow) refused, not silently re-stamped", completedUnconfirmed.status === "error" && completedUnconfirmed.code === "occurrence_not_confirmable");
    const other = await one(occ("2026-09-10", { [OCC_FIELDS.confirmation]: "Confirmed", [OCC_FIELDS.status]: "Completed", [OCC_FIELDS.confirmedByName]: "Morgan Manager" }), CHANGED_NO);
    ck("IT a different answer for an already-confirmed occurrence -> 409 occurrence_already_confirmed (no rewrite)", other.status === "error" && other.code === "occurrence_already_confirmed" && patches().length === 0 && other.error.includes("correction path"));
    const reason = await one(occ("2026-09-10", { [OCC_FIELDS.confirmation]: "Exception Recorded", [OCC_FIELDS.status]: "Completed", [OCC_FIELDS.exceptionReason]: "Staffing" }), { ...CHANGED_YES, exceptionReason: "Venue" });
    ck("IT same answer with a different reason is a change, not a repeat -> 409", reason.status === "error" && reason.code === "occurrence_already_confirmed" && patches().length === 0);
    const flip = await one(occ("2026-09-10", { [OCC_FIELDS.confirmation]: "Exception Recorded", [OCC_FIELDS.status]: "Cancelled", [OCC_FIELDS.exceptionReason]: "Weather" }), { ...CHANGED_NO, delivered: true });
    ck("IT not-delivered cannot be flipped to delivered by a second call", flip.status === "error" && flip.code === "occurrence_already_confirmed" && patches().length === 0);

    const p = (body: unknown) => parseConfirmBody(typeof body === "string" ? body : JSON.stringify(body));
    ck("IT invalid confirmation value refused 400", !p({ occurrenceId: "a:b", confirmation: "confirmed" }).ok && !p({ occurrenceId: "a:b", confirmation: "Went as planned" }).ok && !p({ occurrenceId: "a:b" }).ok);
    ck("IT went_as_planned with delivered:false or a reason is refused (contradiction)", !p({ occurrenceId: "a:b", confirmation: "went_as_planned", delivered: false }).ok && !p({ occurrenceId: "a:b", confirmation: "went_as_planned", exceptionReason: "Weather" }).ok);
    ck("IT malformed body / id refused 400", !p("nope").ok && !p([1]).ok && !p({ occurrenceId: "bad id'", confirmation: "went_as_planned" }).ok && !p({ occurrenceId: "", confirmation: "went_as_planned" }).ok);

    reset([]);
    const nf = await confirmOccurrence(deps(), MGR, req(`${SESSION_REC}:2026-09-10`, WENT));
    ck("IT unknown occurrence -> 404, no lock taken", nf.status === "error" && nf.httpStatus === 404 && lockEvents.length === 0);
    reset([occ("2026-09-10"), occ("2026-09-10", {}, "recDuplicateRow01")]);
    const dup = await confirmOccurrence(deps(), MGR, req(`${SESSION_REC}:2026-09-10`, WENT));
    ck("IT two rows with one Occurrence ID -> 409 occurrence_ambiguous, nothing written", dup.status === "error" && dup.code === "occurrence_ambiguous" && patches().length === 0);
    reset([occ("2026-09-10", { [OCC_FIELDS.session]: [] })]);
    const noSession = await confirmOccurrence(deps(), MGR, req(`${SESSION_REC}:2026-09-10`, WENT));
    ck("IT occurrence without exactly one Session -> 409 occurrence_invalid", noSession.status === "error" && noSession.code === "occurrence_invalid" && patches().length === 0);
    reset([occ("2026-09-10", { [OCC_FIELDS.id]: `${SESSION_REC}:2026-09-10X` }), occ("2026-09-11")]);
    const near = await confirmOccurrence(deps(), MGR, req(`${SESSION_REC}:2026-09-10`, WENT));
    ck("IT the Occurrence ID is re-checked exactly in code (formula ignored by the mock)", near.status === "error" && near.httpStatus === 404);
    reset([occ("2026-09-10", { [OCC_FIELDS.status]: "Done" })]);
    const weird = await confirmOccurrence(deps(), MGR, req(`${SESSION_REC}:2026-09-10`, WENT));
    ck("IT unknown Status value refused, never treated as Scheduled", weird.status === "error" && weird.code === "occurrence_not_confirmable");
  }

  // =========================================================================
  // Timezone
  // =========================================================================
  {
    const s = occurrenceState(occ("2026-09-29", { [OCC_FIELDS.start]: null, [OCC_FIELDS.end]: null }));
    ck("TZ no times: the date must be before TODAY in the organisation's timezone", !hasPassed(s, NOW, "2026-09-29") && hasPassed(s, NOW, "2026-09-30"));
    ck("TZ todayIn uses the organisation timezone (23:30 UTC is already tomorrow in London in BST)", todayIn("Europe/London", new Date("2026-09-29T23:30:00Z")) === "2026-09-30" && todayIn("UTC", new Date("2026-09-29T23:30:00Z")) === "2026-09-29");
    const r = resolveOrganisation(ORG, [{ id: "recA", fields: { ...ORG_ROW.fields, Timezone: "America/New_York" } }]);
    ck("TZ the organisation's own Timezone is used (not hard-coded)", r.ok && r.organisation.timezone === "America/New_York");
    reset([occ("2026-09-29", { [OCC_FIELDS.start]: null, [OCC_FIELDS.end]: null })]);
    orgs = [{ id: "recOrgRowAAAAAAAA", fields: { ...ORG_ROW.fields, Timezone: "Pacific/Kiritimati" } }]; // UTC+14: already 30 Sep there
    const kiri = await confirmOccurrence(deps(), MGR, req(`${SESSION_REC}:2026-09-29`, WENT));
    ck("TZ orchestrator: a date-only occurrence of 29 Sep is past once the organisation's own date is 30 Sep", kiri.status === "ok");
    reset([occ("2026-09-29", { [OCC_FIELDS.start]: null, [OCC_FIELDS.end]: null })]);
    const london = await confirmOccurrence(deps(), MGR, req(`${SESSION_REC}:2026-09-29`, WENT));
    ck("TZ ...but not while it is still 29 Sep in Europe/London", london.status === "error" && london.code === "occurrence_not_passed");
  }

  // =========================================================================
  // HI - history
  // =========================================================================
  {
    reset([occ("2026-09-11")]);
    const rid = occurrences[0].id;
    const r = await confirmOccurrence(deps(), MGR, req(`${SESSION_REC}:2026-09-11`, CHANGED_YES));
    const b = (r as any).body;
    ck("HI actor: Confirmed By User ID = the caller's user id", f(rid)[OCC_FIELDS.confirmedBy] === MGR.userId);
    ck("HI actor name snapshot", f(rid)[OCC_FIELDS.confirmedByName] === "Morgan Manager");
    ck("HI time: Confirmed At = server now (never client-supplied)", f(rid)[OCC_FIELDS.confirmedAt] === NOW.toISOString() && !parseConfirmBody(JSON.stringify({ occurrenceId: "a:b", confirmation: "went_as_planned", confirmedAt: "2020-01-01" })).ok);
    ck("HI before = the unconfirmed Scheduled state", b.before.confirmationState === "Awaiting Confirmation" && b.before.status === "Scheduled" && b.before.confirmation === null && b.before.confirmedAt === null);
    ck("HI after = the new state with stamps", b.occurrence.confirmationState === "Exception Recorded" && b.occurrence.status === "Completed" && b.occurrence.confirmedBy === "Morgan Manager" && b.occurrence.confirmedAt === NOW.toISOString() && b.occurrence.exceptionAt === NOW.toISOString());
    ck("HI the facts and their stamps are ONE PATCH (land together or not at all)", patches().length === 1 && patches()[0].url.endsWith(`/${rid}`));
    const noName = { ...MGR, displayName: null };
    reset([occ("2026-09-11")]);
    await confirmOccurrence(deps(), noName, req(`${SESSION_REC}:2026-09-11`, WENT));
    ck("HI name snapshot falls back to the user id, never blank", f(occurrences[0].id)[OCC_FIELDS.confirmedByName] === MGR.userId);

    reset([occ("2026-10-15")]);
    await confirmOccurrence(deps(), MGR, req(`${SESSION_REC}:2026-10-15`, WENT));
    reset([occ("2026-09-10", { [OCC_FIELDS.status]: "Cancelled" })]);
    await confirmOccurrence(deps(), MGR, req(`${SESSION_REC}:2026-09-10`, WENT));
    ck("HI rejected writes produce no history (no PATCH at all)", patches().length === 0 && occurrences[0].fields[OCC_FIELDS.confirmedAt] === undefined);

    reset([occ("2026-09-11")]);
    await confirmOccurrence(deps(), MGR, req(`${SESSION_REC}:2026-09-11`, CHANGED_NO));
    const stamped = { ...occurrences[0].fields };
    const later = { ...deps(), clock: () => new Date("2026-09-30T09:00:00.000Z") };
    const rep = await confirmOccurrence(later, MGR, req(`${SESSION_REC}:2026-09-11`, CHANGED_NO));
    ck("HI no-op repeat (even later, by anyone) does not duplicate or re-stamp history", rep.status === "ok" && (rep as any).body.changed === false && patches().length === 1 && JSON.stringify(occurrences[0].fields) === JSON.stringify(stamped));

    const idx = readFileSync(join(CANON, "index.ts"), "utf8");
    const confSrc = ["occurrence-confirmation.ts", "confirmation-repository.ts", "confirmation-orchestrator.ts"].map((n) => readFileSync(join(CANON, n), "utf8")).join("\n");
    ck("HI Session History is never written by this slice (it stays structural only)", !/Session History|createHistoryEntries/.test(confSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")) && idx.includes("handleConfirmOccurrence"));
    ck("HI no second audit system: no Supabase audit table / Finance audit written", !/finance_audit_events|rest\/v1\//.test(confSrc));
  }

  // =========================================================================
  // LK - lock
  // =========================================================================
  {
    reset([occ("2026-09-10")]);
    await confirmOccurrence(deps(), MGR, req(`${SESSION_REC}:2026-09-10`, WENT));
    ck("LK the Session's generation lock is taken and released", JSON.stringify(lockEvents) === JSON.stringify([`acquire:${SESSION_REC}`, `release:${SESSION_REC}`]) && lockHeld.size === 0);
    reset([occ("2026-09-10")]);
    lockMode = "busy";
    const busy = await confirmOccurrence(deps(), MGR, req(`${SESSION_REC}:2026-09-10`, WENT));
    ck("LK lock held elsewhere (generation / propagation / another confirmation) -> 409 schedule_busy, nothing written", busy.status === "error" && busy.code === "schedule_busy" && patches().length === 0);
    reset([occ("2026-09-10")]);
    lockMode = "error";
    const lockDown = await confirmOccurrence(deps(), MGR, req(`${SESSION_REC}:2026-09-10`, WENT));
    ck("LK lock store down -> 503, nothing written", lockDown.status === "error" && lockDown.httpStatus === 503 && patches().length === 0);
    reset([occ("2026-09-10")]);
    failPatch = true;
    const pf = await confirmOccurrence(deps(), MGR, req(`${SESSION_REC}:2026-09-10`, WENT));
    ck("LK write failure -> 503 and the lock is still released", pf.status === "error" && pf.httpStatus === 503 && lockHeld.size === 0 && lockEvents.at(-1) === `release:${SESSION_REC}`);
    reset([occ("2026-09-10")]);
    failRead = true;
    const rf = await confirmOccurrence(deps(), MGR, req(`${SESSION_REC}:2026-09-10`, WENT));
    ck("LK read failure -> 503, never 'assume confirmed'", rf.status === "error" && rf.httpStatus === 503 && patches().length === 0);

    // Re-read under the lock: someone else confirmed between the first read and the lock.
    reset([occ("2026-09-10")]);
    let reads = 0;
    onRead = () => {
      reads++;
      if (reads === 2) Object.assign(occurrences[0].fields, { [OCC_FIELDS.confirmation]: "Exception Recorded", [OCC_FIELDS.status]: "Cancelled", [OCC_FIELDS.exceptionReason]: "Weather" });
    };
    const race = await confirmOccurrence(deps(), MGR, req(`${SESSION_REC}:2026-09-10`, WENT));
    ck("LK decision is made on a re-read under the lock (a confirmation that landed first wins; no overwrite)", race.status === "error" && race.code === "occurrence_already_confirmed" && patches().length === 0);

    // Two concurrent identical confirmations: exactly one write.
    reset([occ("2026-09-10")]);
    const shared = lockClient();
    const d = { ...deps(), lock: shared, lockAttempts: 50, lockRetryDelayMs: 1 };
    const [a, c] = await Promise.all([confirmOccurrence(d, MGR, req(`${SESSION_REC}:2026-09-10`, WENT)), confirmOccurrence(d, MGR, req(`${SESSION_REC}:2026-09-10`, WENT))]);
    ck("LK two concurrent identical confirmations -> exactly one PATCH, one changed:true + one no-op", patches().length === 1 && [a, c].filter((x) => x.status === "ok" && (x as any).body.changed === true).length === 1 && [a, c].filter((x) => x.status === "ok" && (x as any).body.changed === false).length === 1);
  }

  // =========================================================================
  // F4 - Finance F4 integration through the UNCHANGED finance-billing.ts
  // =========================================================================
  {
    const SERVICE_ID = "FSV-AAAAAAAAAAAA";
    const session: Row = { id: SESSION_REC, fields: { "Session ID": "TEST-CONF", "Session Name": "Confirmation test", "Finance Service ID": SERVICE_ID } };
    const ctx: ServiceContext = {
      service: { serviceId: SERVICE_ID, clientId: "FCL-AAAAAAAAAAAA", name: "PPA cover", status: "active", revision: 1, updatedAt: null },
      client: { clientId: "FCL-AAAAAAAAAAAA", name: "School", status: "active", billingContactName: null, billingEmail: null, billingCcEmails: [], paymentTermsDaysOverride: null, poRequired: false, revision: 1, updatedAt: null },
      terms: {
        ok: true,
        history: [
          { termsId: "FCT-AAAAAAAAAAAA", serviceId: SERVICE_ID, effectiveFrom: "2026-09-01", effectiveUntil: null, payer: "client", chargeType: "fixed_per_session", amountMinor: 5000, vatTreatment: "plus_vat", vatRateBasisPoints: 2000, defaultBillableQuantity: null, subscriptionFrequency: null, otherDescription: null },
        ],
      },
      lifecycle: [{ lifecycleId: "FSL-AAAAAAAAAAAA", serviceId: SERVICE_ID, status: "active", effectiveFrom: null, effectiveUntil: null, supersededBy: null, reason: null }],
    };
    const bill = (row: Row) => resolveOccurrenceBilling({ occurrence: occurrenceFacts(row, session), findService: (id) => (id === SERVICE_ID ? ctx : null), overrides: [], now: NOW, today: "2026-09-29" });

    reset([occ("2026-09-10"), occ("2026-09-11"), occ("2026-09-14"), occ("2026-09-15", { "Operational Notes": "Delivered in full" })]);
    const [w, y, n, a] = occurrences;
    ck("F4 awaiting (before any confirmation) resolves not eligible (awaiting_confirmation)", bill(a).outcome === "not_eligible" && bill(a).eligibility.status === "awaiting_confirmation");
    await confirmOccurrence(deps(), MGR, req(`${SESSION_REC}:2026-09-10`, WENT));
    await confirmOccurrence(deps(), MGR, req(`${SESSION_REC}:2026-09-11`, CHANGED_YES));
    await confirmOccurrence(deps(), MGR, req(`${SESSION_REC}:2026-09-14`, CHANGED_NO));
    const bw = bill(w);
    const by = bill(y);
    const bn = bill(n);
    ck("F4 went as planned -> eligible, £50 + VAT = £60 gross", bw.outcome === "eligible" && bw.expected?.grossMinor === 6000, JSON.stringify(bw.eligibility));
    ck("F4 something changed + delivered -> eligible (£60)", by.outcome === "eligible" && by.eligibility.changeRecorded === true && by.expected?.grossMinor === 6000, JSON.stringify(by.eligibility));
    ck("F4 something changed + not delivered -> not eligible (cancelled), no billable value", bn.outcome === "not_eligible" && bn.eligibility.status === "cancelled" && bn.eligibility.delivered === false);
    ck("F4 awaiting remains not eligible, and free-text 'Delivered in full' is still ignored", bill(a).outcome === "not_eligible" && bill(a).eligibility.status === "awaiting_confirmation");
    ck("F4 no Finance override or Finance write is involved (only Session Occurrences PATCHed)", calls.filter((c) => c.method !== "GET").every((c) => c.url.includes(encodeURIComponent("Session Occurrences"))));

    const billingSrc = readFileSync(join(FINANCE_CANON, "finance-billing.ts"), "utf8");
    ck("F4 Finance reads exactly the fields this writer produces (Status + Confirmation State values)", ["Scheduled", "Completed", "Cancelled", "Postponed"].every((v) => billingSrc.includes(`"${v}"`)) && ["Awaiting Confirmation", "Confirmed", "Exception Recorded"].every((v) => billingSrc.includes(`"${v}"`)));
  }

  // =========================================================================
  // Pure decision table
  // =========================================================================
  {
    const ctx = { now: NOW, today: "2026-09-29", actor: { userId: "u", name: "N" } };
    const s = (over: Record<string, any>) => occurrenceState(occ("2026-09-10", over));
    const w = req("x:1", WENT);
    ck("DT unconfirmed passed Scheduled -> write", decide(s({}), w, ctx).kind === "write");
    ck("DT 'Awaiting Confirmation' -> write", decide(s({ [OCC_FIELDS.confirmation]: "Awaiting Confirmation" }), w, ctx).kind === "write");
    ck("DT Confirmed/Completed + went_as_planned -> noop", decide(s({ [OCC_FIELDS.confirmation]: "Confirmed", [OCC_FIELDS.status]: "Completed" }), w, ctx).kind === "noop");
    ck("DT Confirmed but Scheduled (inconsistent, hand-edited) -> refuse, never a noop", decide(s({ [OCC_FIELDS.confirmation]: "Confirmed" }), w, ctx).kind === "refuse");
  }

  // =========================================================================
  // Z - drift / code checks
  // =========================================================================
  {
    for (const n of ["occurrence-confirmation.ts", "confirmation-repository.ts", "confirmation-orchestrator.ts"]) {
      ck(`Z tests/support/${n} is byte-identical to the canonical session-occurrences copy`, readFileSync(join(HERE, n), "utf8") === readFileSync(join(CANON, n), "utf8"));
    }
    ck("Z the lock client used is the Schedule generation lock client (same interface)", readFileSync(join(HERE, "lock-client.ts"), "utf8").includes("acquire_generation_lock") && readFileSync(join(CANON, "lock-client.ts"), "utf8").includes("acquire_generation_lock"));
    const pure = readFileSync(join(CANON, "occurrence-confirmation.ts"), "utf8");
    ck("Z the pure module has no fetch / Deno / Airtable I/O", !/fetch\(|Deno\.|api\.airtable\.com/.test(pure));
    const repo = readFileSync(join(CANON, "confirmation-repository.ts"), "utf8");
    ck("Z the repository's only write is a PATCH of Session Occurrences (no create / delete / other table)", (repo.match(/method: "/g) || []).length === 1 && repo.includes('method: "PATCH"') && !repo.includes('"DELETE"') && !repo.includes('"POST"'));
    ck("Z Finance code is not modified by this slice (no confirmation writer in finance/)", !readFileSync(join(FINANCE_CANON, "index.ts"), "utf8").includes("confirm-occurrence"));
  }

  for (const [s, n, e] of R) console.log(`${s}  ${n}${s === "FAIL" && e ? `  -- ${e}` : ""}`);
  console.log(`\noccurrence-confirmation: ${R.length - failed}/${R.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
