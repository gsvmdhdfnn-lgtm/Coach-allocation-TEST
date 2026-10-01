/**
 * Shared in-memory world for the Finance F13 (suppliers) and F14 (supplier
 * credits) suites: fake Airtable (Sessions, Session Occurrences, Venues,
 * Feature Controls, Organisation & Branding), fake PostgREST, and fake
 * finance_supplier_* database functions with the same rules, CHECKs and
 * guard triggers as the TEST SQL (finance_f13_suppliers +
 * finance_f14_supplier_credits). The REAL orchestrators and repository run
 * against it. Installs globalThis.fetch on import.
 */
import { type FinanceGrantRow, FINANCE_MODULE_KEY, isTenantKey } from "./finance-access.ts";
import { type InstalmentAction, parseAction, parseAgreement, parseSupplierCreate, parseSupplierUpdate } from "./finance-suppliers.ts";
import { type SupplierDeps, changeInstalmentAction, createAgreement, createSupplier, readAgreement, readInstalment, updateSupplier, versionAgreement } from "./finance-suppliers-orchestrator.ts";
import { type CreditAction, parseCreditAction, parseCreditCreate } from "./finance-supplier-credits.ts";
import { createCredit, creditAction, readCredit } from "./finance-supplier-credits-orchestrator.ts";

export const R: [string, string, string?][] = [];
export let failed = 0;
export function ck(name: string, cond: unknown, extra?: string) {
  const ok = !!cond;
  if (!ok) failed++;
  R.push([ok ? "PASS" : "FAIL", name, extra]);
}

export const ORG = "ORG-TEST-001";
export const ORG_REC = "recYXqi1DTZ8ZECPQ";
export const MGR = "285f819e-e0d4-4257-8121-5f16781e97ba";
export const VIEWER = "aaaaaaaa-e0d4-4257-8121-5f16781e97ba";
export const NOGRANT = "bbbbbbbb-e0d4-4257-8121-5f16781e97ba";
export const g = (level: unknown): FinanceGrantRow => ({ organisation_id: ORG, access_level: level, revoked_at: null });
export const mgr = { userId: MGR, role: "management", active: true, organisationId: ORG };
export const viewer = { userId: VIEWER, role: "management", active: true, organisationId: ORG };
export const nogrant = { userId: NOGRANT, role: "management", active: true, organisationId: ORG };
export const coach = { userId: MGR, role: "coach", active: true, organisationId: ORG };
export const parent = { userId: MGR, role: "parent", active: true, organisationId: ORG };
export const ORG_ROW = { id: ORG_REC, fields: { "Organisation ID": ORG, "Organisation Name": "Test Org", Timezone: "Europe/London", Active: true } };

export const rid = (p: string) => `rec${p.padEnd(14, "0").slice(0, 14)}`;
export const VENUE_REC = rid("VenueA");
export const SA = rid("SessVenA"), SB = rid("SessVenB"), SN = rid("SessNoSvc"), SE = rid("SessEmpty"), SD1 = rid("SessDup1"), SD2 = rid("SessDup2");

export type Row = { id: string; fields: Record<string, any> };
export interface World {
  grants: Record<string, FinanceGrantRow[]>;
  moduleOn: boolean;
  at: Record<string, Row[]>;
  sb: Record<string, Record<string, any>[]>;
  audit: any[];
  lockHeld: string | null;
  airtableWrites: number;
  airtableReads: string[];
  rpcCalls: number;
}
export let world: World;
export const NOW = new Date("2026-10-15T12:00:00.000Z");
export let seq = 0;
export const json = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
export const tick = () => new Promise((r) => setTimeout(r, 0));

export const occ = (key: string, date: string, session: string, status: string) => ({ id: rid(key), fields: { "Occurrence ID": `OCC-${key}:${date}`, Date: date, Status: status, Session: [session] } });
export const A_DATES = ["2026-10-01", "2026-10-08", "2026-10-15", "2026-10-22", "2026-10-29", "2026-11-05", "2026-11-12", "2026-11-19", "2026-11-26", "2026-12-03"];

export function reset() {
  seq = 0;
  const occA = A_DATES.map((d, k) => occ(`OccA${k}`, d, SA, d < "2026-10-15" ? "Completed" : "Scheduled"));
  occA.push(occ("OccAX", "2026-12-10", SA, "Cancelled"), occ("OccAP", "2026-12-17", SA, "Postponed"), occ("OccAL", "2027-01-07", SA, "Scheduled"));
  const occB = ["2026-11-02", "2026-11-09", "2026-11-16"].map((d, k) => occ(`OccB${k}`, d, SB, "Scheduled"));
  const occN = ["2026-10-05", "2026-10-12"].map((d, k) => occ(`OccN${k}`, d, SN, "Completed"));
  const occD = [occ("OccD0", "2026-11-03", SD1, "Scheduled"), occ("OccD1", "2026-11-04", SD2, "Scheduled")];
  const session = (id: string, sid: string, name: string, programme: string | null, fsv: string | null, occs: Row[]) => ({ id, fields: { "Session ID": sid, "Session Name": name, Programme: programme, "Finance Service ID": fsv, "Session Occurrences": occs.map((o) => o.id) } });
  world = {
    grants: { [MGR]: [g("manage")], [VIEWER]: [g("view")], [NOGRANT]: [] },
    moduleOn: true,
    at: {
      "Organisation & Branding": [ORG_ROW],
      Sessions: [
        session(SA, "ZZ-VENUE-A", "ZZTEST Venue A Academy", "Academy", "FSV-AAAAAAAAAAAA", occA),
        session(SB, "ZZ-VENUE-B", "ZZTEST Venue B After School", "After School", "FSV-BBBBBBBBBBBB", occB),
        session(SN, "ZZ-NOSVC", "ZZTEST No Service", "Camps", null, occN),
        session(SE, "ZZ-EMPTY", "ZZTEST Empty", "Holiday", "FSV-CCCCCCCCCCCC", []),
        session(SD1, "ZZ-DUP", "ZZTEST Dup 1", "Academy", "FSV-DDDDDDDDDDDD", [occD[0]]),
        session(SD2, "ZZ-DUP", "ZZTEST Dup 2", "Academy", "FSV-DDDDDDDDDDDD", [occD[1]]),
      ],
      "Session Occurrences": [...occA, ...occB, ...occN, ...occD],
      Venues: [{ id: VENUE_REC, fields: { "Venue Name": "ZZTEST Venue Hall", "Venue ID": "VEN-ZZ-A" } }],
    },
    sb: { finance_suppliers: [], finance_supplier_agreements: [], finance_supplier_allocations: [], finance_supplier_instalments: [], finance_supplier_payments: [], finance_supplier_credits: [], finance_supplier_credit_sessions: [], finance_supplier_credit_applications: [] },
    audit: [],
    lockHeld: null,
    airtableWrites: 0,
    airtableReads: [],
    rpcCalls: 0,
  };
}
export const AT = (t: string) => world.at[t];
export const T_ = (t: string) => world.sb[t];

// ----- fake finance_supplier_* database functions (same rules as the TEST SQL) -----
export class Refused extends Error {}
export const no: (code: string) => never = (code) => {
  throw new Refused(`f13:${code}`);
};
export const no14: (code: string) => never = (code) => {
  throw new Refused(`f14:${code}`);
};
export const CHECK = (cond: unknown, what: string) => {
  if (!cond) throw new Error(`${what} check violation`);
};
export const ID = { FSU: /^FSU-[0-9A-F]{12}$/, FSA: /^FSA-[0-9A-F]{12}$/, FSI: /^FSI-[0-9A-F]{12}$/, FSP: /^FSP-[0-9A-F]{12}$/, FSC: /^FSC-[0-9A-F]{12}$/, FSX: /^FSX-[0-9A-F]{12}$/ };
export const isInt = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v);
export function audit(events: any[]) {
  if (!Array.isArray(events) || !events.length) no("audit_missing");
  for (const e of events) CHECK(/^[a-z][a-z_]*\.[a-z][a-z_]*$/.test(e.event_type) && /^[a-z][a-z_]*$/.test(e.entity_type), "audit");
  world.audit.push(...events.map((e) => ({ ...e, id: ++seq, occurred_at: NOW.toISOString() })));
}
export function checkSupplier(s: any) {
  CHECK(ID.FSU.test(s.supplier_id) && String(s.name ?? "").trim() && ["venue", "contractor", "software_service", "other"].includes(s.supplier_type) && s.revision >= 1, "finance_suppliers");
  CHECK(s.venue_record_id === null || s.supplier_type === "venue", "finance_suppliers venue");
  CHECK(s.vat_treatment === null || ["plus_vat", "vat_included", "no_vat"].includes(s.vat_treatment), "finance_suppliers vat");
}
export function checkAgreement(a: any) {
  CHECK(ID.FSA.test(a.agreement_id) && ["fixed", "hourly", "one_off", "scheduled", "custom_dates"].includes(a.cost_type) && ["direct", "general"].includes(a.classification), "agreements");
  CHECK(a.classification === "direct" || a.link_state === "not_applicable", "agreements link/classification");
  CHECK(a.link_state !== "linked" || a.allocation_count > 0, "agreements linked/allocation");
  CHECK((a.cost_type === "custom_dates") === (a.frequency === "custom_dates"), "agreements custom/frequency");
  CHECK(a.cost_type !== "hourly" || (a.hourly_rate_minor !== null && a.expected_monthly_hours_hundredths !== null && a.frequency === "monthly"), "agreements hourly");
  CHECK(a.instalment_count >= 1 && a.instalment_count <= 120 && a.total_planned_minor > 0 && (a.amount_minor === null || a.amount_minor > 0), "agreements amounts");
  CHECK(a.effective_until === null || a.effective_until >= a.effective_from, "agreements dates");
}
export function checkInstalment(i: any) {
  CHECK(ID.FSI.test(i.instalment_id) && i.planned_minor > 0 && i.amount_due_minor > 0 && i.paid_minor >= 0 && [i.planned_minor, i.amount_due_minor, i.paid_minor].every(isInt), "instalments");
  CHECK(i.paid_minor <= i.amount_due_minor, "instalments paid<=due");
  CHECK(i.amount_state === "confirmed" || i.paid_minor === 0, "instalments estimate unpaid");
  CHECK((i.cancelled_at === null) === (i.cancel_reason === null) && (i.cancelled_at === null) === (i.cancelled_by === null), "instalments cancel fields");
  CHECK(i.cancelled_at === null || i.paid_minor === 0, "instalments cancel unpaid");
  // F14 (finance_f14_supplier_credits)
  CHECK(isInt(i.credited_minor) && i.credited_minor >= 0, "instalments credited");
  CHECK(i.paid_minor + i.credited_minor <= i.amount_due_minor, "instalments paid+credited<=due");
  CHECK(i.amount_state === "confirmed" || i.credited_minor === 0, "instalments credit confirmed");
  CHECK(i.cancelled_at === null || i.credited_minor === 0, "instalments credit not cancelled");
}
/** finance_supplier_instalment_guard + CHECKs. */
export function updateInstalment(org: string, id: string, patch: Record<string, any>) {
  const rows = T_("finance_supplier_instalments");
  const k = rows.findIndex((x) => x.organisation_id === org && x.instalment_id === id);
  const old = rows[k];
  const n = { ...old, ...patch };
  for (const f of ["organisation_id", "instalment_id", "agreement_id", "supplier_id", "sequence", "original_due_date", "planned_minor", "created_at", "created_by", "split_from_instalment_id"]) if (n[f] !== old[f]) no("history_is_append_only");
  if (old.cancelled_at !== null || (old.amount_state === "confirmed" && old.paid_minor + old.credited_minor === old.amount_due_minor)) no("history_is_append_only");
  if (n.paid_minor < old.paid_minor || (old.amount_state === "confirmed" && n.amount_state === "estimated")) no("history_is_append_only");
  if (n.amount_due_minor > old.amount_due_minor && !(old.amount_state === "estimated" && n.amount_state === "confirmed")) no("history_is_append_only");
  if (n.amount_due_minor !== old.amount_due_minor && n.paid_minor !== old.paid_minor) no("history_is_append_only");
  if (n.credited_minor !== old.credited_minor && (n.paid_minor !== old.paid_minor || n.amount_due_minor !== old.amount_due_minor)) no("history_is_append_only");
  checkInstalment(n);
  rows[k] = n;
}
export function insertInstalments(rows: any[]) {
  for (const raw of rows) {
    // finance_supplier_instalment_rows: credited_minor defaults to 0 when a caller omits it
    const i = { credited_minor: 0, ...raw };
    checkInstalment(i);
    if (T_("finance_supplier_instalments").some((x) => x.organisation_id === i.organisation_id && x.instalment_id === i.instalment_id)) throw new Error("instalments pkey");
    T_("finance_supplier_instalments").push({ ...i });
  }
}
export function rpcBody(fn: string, a: any): unknown {
  if (fn === "finance_supplier_write") {
    const s = a.p_supplier;
    checkSupplier(s);
    const rows = T_("finance_suppliers");
    if (a.p_expected_revision === null) {
      if (rows.some((x) => x.organisation_id === s.organisation_id && x.supplier_id === s.supplier_id)) throw new Error("suppliers pkey");
      rows.push({ ...s });
    } else {
      const k = rows.findIndex((x) => x.organisation_id === s.organisation_id && x.supplier_id === s.supplier_id);
      if (k < 0) no("supplier_not_found");
      if (rows[k].revision !== a.p_expected_revision) no("supplier_changed");
      if (s.created_at !== rows[k].created_at || s.created_by !== rows[k].created_by || s.revision !== rows[k].revision + 1) no("history_is_append_only");
      rows[k] = { ...s };
    }
    audit(a.p_events);
    return { supplier_id: s.supplier_id };
  }
  if (fn === "finance_supplier_agreement_record") {
    const ag = a.p_agreement;
    const org = ag.organisation_id;
    const prev = ag.supersedes_agreement_id;
    if (!T_("finance_suppliers").some((x) => x.organisation_id === org && x.supplier_id === ag.supplier_id)) no("supplier_not_found");
    const inst = T_("finance_supplier_instalments");
    if (prev !== null) {
      const p = T_("finance_supplier_agreements").find((x) => x.organisation_id === org && x.agreement_id === prev && x.supplier_id === ag.supplier_id);
      if (!p) no("agreement_not_found");
      if (T_("finance_supplier_agreements").some((x) => x.organisation_id === org && x.supersedes_agreement_id === prev)) no("agreement_already_versioned");
      if (ag.effective_from <= p.effective_from) no("version_must_start_later");
      const after = inst.filter((i) => i.organisation_id === org && i.agreement_id === prev && i.due_date >= ag.effective_from);
      if (after.some((i) => i.paid_minor > 0)) no("paid_instalment_after_change");
      if (after.some((i) => i.credited_minor > 0)) no14("credited_instalment_after_change");
      const open = after.filter((i) => i.cancelled_at === null);
      if (open.length !== a.p_cancel.length || a.p_cancel.some((c: any) => !open.some((i) => i.instalment_id === c.instalment_id && i.paid_minor === 0 && i.credited_minor === 0))) no("agreement_changed");
    } else if (a.p_cancel.length !== 0) no("snapshot_mismatch");
    checkAgreement(ag);
    T_("finance_supplier_agreements").push({ ...ag });
    for (const x of a.p_allocations) {
      CHECK(/^rec[A-Za-z0-9]{14}$/.test(x.occurrence_record_id) && isInt(x.allocated_minor) && x.allocated_minor >= 0, "allocations");
      if (T_("finance_supplier_allocations").some((y) => y.agreement_id === x.agreement_id && y.occurrence_record_id === x.occurrence_record_id)) throw new Error("allocations pkey");
      T_("finance_supplier_allocations").push({ ...x });
    }
    insertInstalments(a.p_instalments);
    for (const c of a.p_cancel) updateInstalment(org, c.instalment_id, { cancelled_at: c.cancelled_at, cancelled_by: c.cancelled_by, cancel_reason: c.cancel_reason });
    const mine = inst.filter((i) => i.organisation_id === org && i.agreement_id === ag.agreement_id);
    const al = T_("finance_supplier_allocations").filter((x) => x.organisation_id === org && x.agreement_id === ag.agreement_id);
    const total = mine.reduce((s, i) => s + i.planned_minor, 0);
    if (total !== ag.total_planned_minor || mine.length !== ag.instalment_count || al.length !== ag.allocation_count || (al.length > 0 && al.reduce((s, x) => s + x.allocated_minor, 0) !== total) || mine.some((i) => i.supplier_id !== ag.supplier_id || i.paid_minor !== 0 || i.credited_minor !== 0 || i.cancelled_at !== null)) no("snapshot_mismatch");
    audit(a.p_events);
    return { agreement_id: ag.agreement_id, total_planned_minor: total, instalment_count: mine.length, cancelled: a.p_cancel.length };
  }
  if (fn === "finance_supplier_instalment_change") {
    const org = a.p_org;
    const v = T_("finance_supplier_instalments").find((x) => x.organisation_id === org && x.instalment_id === a.p_instalment_id);
    if (!v) no("instalment_not_found");
    const e = a.p_expected;
    if (v.paid_minor !== e.paid_minor || v.credited_minor !== (e.credited_minor ?? 0) || v.amount_due_minor !== e.amount_due_minor || v.due_date !== e.due_date || v.amount_state !== e.amount_state || (v.cancelled_at !== null) !== e.cancelled) no("instalment_changed");
    if (v.cancelled_at !== null) no("instalment_cancelled");
    const remaining = v.amount_due_minor - v.paid_minor - v.credited_minor;
    if (remaining === 0) no("instalment_paid");
    const ch = a.p_change;
    if (a.p_kind === "confirm_estimate") {
      if (v.amount_state !== "estimated") no("already_confirmed");
      updateInstalment(org, v.instalment_id, { amount_state: "confirmed", amount_due_minor: ch.amount_due_minor });
    } else if (a.p_kind === "move") {
      updateInstalment(org, v.instalment_id, { due_date: ch.due_date });
    } else if (a.p_kind === "split") {
      const kids = a.p_new_instalments.map((x: any) => ({ credited_minor: 0, ...x }));
      const sumKids = kids.reduce((s: number, x: any) => s + x.amount_due_minor, 0);
      if (!kids.length || ch.amount_due_minor - v.paid_minor - v.credited_minor <= 0 || ch.amount_due_minor + sumKids !== v.amount_due_minor) no("split_mismatch");
      updateInstalment(org, v.instalment_id, { amount_due_minor: ch.amount_due_minor, due_date: ch.due_date });
      insertInstalments(kids);
      if (kids.some((n: any) => n.split_from_instalment_id !== v.instalment_id || n.agreement_id !== v.agreement_id || n.amount_state !== v.amount_state || n.paid_minor !== 0 || n.credited_minor !== 0)) no("split_mismatch");
    } else if (a.p_kind === "payment") {
      if (v.amount_state !== "confirmed") no("amount_still_estimated");
      const amt = a.p_payment.amount_minor;
      if (amt <= 0 || amt > remaining) no("overpayment");
      if (a.p_payment.remaining_after_minor !== remaining - amt || a.p_payment.instalment_id !== v.instalment_id) no("snapshot_mismatch");
      updateInstalment(org, v.instalment_id, { paid_minor: v.paid_minor + amt });
      CHECK(ID.FSP.test(a.p_payment.payment_id) && a.p_payment.remaining_after_minor >= 0, "payments");
      T_("finance_supplier_payments").push({ ...a.p_payment });
    } else if (a.p_kind === "cancel") {
      if (v.paid_minor !== 0) no("instalment_partially_paid");
      if (v.credited_minor !== 0) no14("instalment_has_credit");
      updateInstalment(org, v.instalment_id, { cancelled_at: ch.cancelled_at, cancelled_by: ch.cancelled_by, cancel_reason: ch.cancel_reason });
    } else no("unknown_change");
    audit(a.p_events);
    return { instalment_id: v.instalment_id, kind: a.p_kind };
  }
  if (fn === "finance_supplier_credit_record") return creditRecord(a);
  if (fn === "finance_supplier_credit_change") return creditChange(a);
  throw new Error(`unknown rpc ${fn}`);
}

// ----- F14 credit functions (same rules as finance_f14_supplier_credits) -----
export const activeApplied = (org: string, creditId: string) => T_("finance_supplier_credit_applications").filter((x) => x.organisation_id === org && x.credit_id === creditId && x.unapplied_at === null).reduce((s, x) => s + x.amount_minor, 0);
function checkCredit(c: any) {
  CHECK(ID.FSC.test(c.credit_id) && ["sessions", "agreement", "supplier"].includes(c.scope) && isInt(c.amount_minor) && c.amount_minor > 0 && c.currency === "GBP", "credits");
  CHECK(["credit_note", "refund_adjustment", "compensation"].includes(c.source_type) && String(c.source_reference ?? "").trim() && String(c.reason ?? "").trim(), "credits source/reason");
  CHECK((c.scope === "supplier") === (c.agreement_id === null), "credits scope/agreement");
  CHECK(c.scope === "agreement" || (c.finance_service_id === null && c.programme_label === null), "credits fsv");
  CHECK((c.voided_at === null) === (c.voided_by === null) && (c.voided_at === null) === (c.void_reason === null), "credits void fields");
}
function creditRecord(a: any) {
  const c = a.p_credit;
  const org = c.organisation_id;
  if (!T_("finance_suppliers").some((x) => x.organisation_id === org && x.supplier_id === c.supplier_id)) no("supplier_not_found");
  if (c.voided_at !== null) no("snapshot_mismatch");
  if (c.credit_date > "2026-10-16") no14("credit_date_in_future");
  if (T_("finance_supplier_credits").some((x) => x.organisation_id === org && x.supplier_id === c.supplier_id && x.source_type === c.source_type && x.source_reference.toLowerCase() === c.source_reference.toLowerCase() && x.voided_at === null)) no14("duplicate_credit");
  let ag: any = null;
  if (c.agreement_id !== null) {
    ag = T_("finance_supplier_agreements").find((x) => x.organisation_id === org && x.agreement_id === c.agreement_id);
    if (!ag) no("agreement_not_found");
    if (ag.supplier_id !== c.supplier_id) no14("agreement_not_for_supplier");
  }
  if (c.scope === "sessions") {
    if (ag?.classification !== "direct" || ag?.link_state !== "linked") no14("agreement_has_no_sessions");
    if (!a.p_sessions.length) no("snapshot_mismatch");
    if (a.p_sessions.some((s: any) => s.credit_id !== c.credit_id || s.organisation_id !== org || !T_("finance_supplier_allocations").some((x) => x.organisation_id === org && x.agreement_id === c.agreement_id && x.occurrence_record_id === s.occurrence_record_id))) no14("session_not_in_agreement");
    if (a.p_sessions.reduce((s: number, x: any) => s + x.adjustment_minor, 0) !== c.amount_minor) no("snapshot_mismatch");
  } else if (a.p_sessions.length) no("snapshot_mismatch");
  checkCredit(c);
  if (T_("finance_supplier_credits").some((x) => x.organisation_id === org && x.credit_id === c.credit_id)) throw new Error("credits pkey");
  T_("finance_supplier_credits").push({ ...c });
  for (const s of a.p_sessions) {
    CHECK(/^rec[A-Za-z0-9]{14}$/.test(s.occurrence_record_id) && isInt(s.adjustment_minor) && s.adjustment_minor >= 0, "credit sessions");
    T_("finance_supplier_credit_sessions").push({ ...s });
  }
  audit(a.p_events);
  return { credit_id: c.credit_id };
}
function creditChange(a: any) {
  const org = a.p_org;
  const credits = T_("finance_supplier_credits");
  const ck_ = credits.findIndex((x) => x.organisation_id === org && x.credit_id === a.p_credit_id);
  if (ck_ < 0) no14("credit_not_found");
  const c = credits[ck_];
  const apps = T_("finance_supplier_credit_applications");
  const applied = activeApplied(org, c.credit_id);
  if (applied !== a.p_expected.applied_minor) no14("credit_changed");
  if (a.p_kind === "void") {
    if (c.voided_at !== null) no14("already_voided");
    if (apps.some((x) => x.organisation_id === org && x.credit_id === c.credit_id)) no14("credit_has_applications");
    const n = { ...c, voided_at: a.p_void.voided_at, voided_by: a.p_void.voided_by, void_reason: a.p_void.void_reason };
    if (n.voided_at === null) no("history_is_append_only");
    checkCredit(n);
    credits[ck_] = n;
    audit(a.p_events);
    return { credit_id: c.credit_id, kind: "void" };
  }
  let inst: string;
  let appIdx = -1;
  if (a.p_kind === "apply") inst = a.p_application.instalment_id;
  else if (a.p_kind === "unapply") {
    appIdx = apps.findIndex((x) => x.organisation_id === org && x.application_id === a.p_application.application_id && x.credit_id === c.credit_id);
    if (appIdx < 0) no14("application_not_found");
    if (apps[appIdx].unapplied_at !== null) no14("already_unapplied");
    inst = apps[appIdx].instalment_id;
  } else no("unknown_change");
  const i = T_("finance_supplier_instalments").find((x) => x.organisation_id === org && x.instalment_id === inst);
  if (!i) no("instalment_not_found");
  const e = a.p_expected.instalment;
  if (!e || e.instalment_id !== inst || i.paid_minor !== e.paid_minor || i.credited_minor !== e.credited_minor || i.amount_due_minor !== e.amount_due_minor) no("instalment_changed");
  if (i.cancelled_at !== null) no("instalment_cancelled");
  if (i.amount_state === "confirmed" && i.amount_due_minor - i.paid_minor - i.credited_minor === 0) no14("instalment_settled");
  if (a.p_kind === "apply") {
    const p = a.p_application;
    if (c.voided_at !== null) no14("credit_voided");
    if (i.supplier_id !== c.supplier_id) no14("wrong_supplier");
    if (i.amount_state !== "confirmed") no14("instalment_estimated");
    if (p.credit_id !== c.credit_id || p.organisation_id !== org || p.supplier_id !== c.supplier_id || p.agreement_id !== i.agreement_id || p.unapplied_at !== null || !(p.amount_minor > 0)) no("snapshot_mismatch");
    if (apps.some((x) => x.organisation_id === org && x.credit_id === c.credit_id && x.instalment_id === inst && x.unapplied_at === null)) no14("already_applied_to_instalment");
    if (p.amount_minor > c.amount_minor - applied) no14("over_credit");
    if (p.amount_minor > i.amount_due_minor - i.paid_minor - i.credited_minor) no14("over_instalment");
    CHECK(ID.FSX.test(p.application_id) && isInt(p.amount_minor), "applications");
    if (apps.some((x) => x.organisation_id === org && x.application_id === p.application_id)) throw new Error("applications pkey");
    apps.push({ ...p });
    updateInstalment(org, inst, { credited_minor: i.credited_minor + p.amount_minor });
  } else {
    const p = a.p_application;
    if (p.unapplied_at == null || p.unapplied_by == null || p.unapply_reason == null) no("snapshot_mismatch");
    const old = apps[appIdx];
    apps[appIdx] = { ...old, unapplied_at: p.unapplied_at, unapplied_by: p.unapplied_by, unapply_reason: p.unapply_reason };
    updateInstalment(org, inst, { credited_minor: i.credited_minor - old.amount_minor });
  }
  audit(a.p_events);
  return { credit_id: c.credit_id, kind: a.p_kind, instalment_id: inst };
}
export function rpcFn(fn: string, a: any): unknown {
  const snap = JSON.stringify({ sb: world.sb, audit: world.audit });
  try {
    return rpcBody(fn, a);
  } catch (e) {
    const s = JSON.parse(snap);
    world.sb = s.sb;
    world.audit = s.audit;
    throw e;
  }
}
export function postgrest(url: string, method: string): Response {
  const u = new URL(url);
  const table = u.pathname.split("/").pop() as string;
  const rows = table === "finance_audit_events" ? world.audit : world.sb[table];
  if (!rows) return json({ message: "no table" }, 404);
  // Append-only triggers / RLS: the API never writes these tables directly.
  if (method === "PATCH" || method === "DELETE") return json({ code: "P0001", message: "f13:history_is_append_only" }, 400);
  if (method !== "GET") return json({ message: "F13 writes only through its database functions" }, 403);
  const fs: [string, string][] = [];
  let order: string | null = null;
  for (const [k, v] of u.searchParams) {
    if (k === "order") order = v;
    else if (k !== "select") fs.push([k, v.replace(/^eq\./, "")]);
  }
  let out = rows.filter((r) => fs.every(([k, v]) => String(r[k] ?? "") === v)).map((r) => JSON.parse(JSON.stringify(r)));
  if (order) {
    const keys = order.split(",").map((s) => s.split(".")[0]);
    out = out.sort((x, y) => {
      for (const k of keys) {
        if (x[k] < y[k]) return -1;
        if (x[k] > y[k]) return 1;
      }
      return 0;
    });
  }
  return json(out);
}
export function airtable(url: string, method: string): Response {
  if (method !== "GET") {
    world.airtableWrites++;
    return json({ error: "F13 must not write Airtable" }, 418);
  }
  const u = new URL(url);
  const t = decodeURIComponent(u.pathname.split("/").pop() as string);
  world.airtableReads.push(t);
  if (t === "Feature Controls") return json({ records: [{ id: "recI5wFXcjUfY6BXy", fields: { "Feature Key": FINANCE_MODULE_KEY, ...(world.moduleOn ? { Enabled: true } : {}) } }] });
  let rows = (world.at[t] ?? []).map((r) => JSON.parse(JSON.stringify(r)));
  const f = u.searchParams.get("filterByFormula");
  if (f) {
    const ids = [...f.matchAll(/RECORD_ID\(\)='(rec[A-Za-z0-9]{14})'/g)].map((x) => x[1]);
    const sids = [...f.matchAll(/\{Session ID\}='([^']+)'/g)].map((x) => x[1]);
    const fsv = [...f.matchAll(/\{Finance Service ID\}='([^']+)'/g)].map((x) => x[1]);
    if (ids.length) rows = rows.filter((r) => ids.includes(r.id));
    if (sids.length) rows = rows.filter((r) => sids.includes(r.fields["Session ID"]));
    if (fsv.length) rows = rows.filter((r) => fsv.includes(r.fields["Finance Service ID"]));
  }
  for (const r of rows) for (const k of Object.keys(r.fields)) if (r.fields[k] === null || (Array.isArray(r.fields[k]) && !r.fields[k].length)) delete r.fields[k];
  return json({ records: rows });
}

globalThis.fetch = (async (input: any, init: any = {}) => {
  await tick();
  const url = String(input);
  const method = (init.method || "GET").toUpperCase();
  const body = init.body ? JSON.parse(init.body) : undefined;
  if (url.includes("/rest/v1/finance_access_grants")) {
    const mm = /^eq\.(.+)$/.exec(new URL(url).searchParams.get("user_id") || "");
    return json(mm ? world.grants[mm[1]] ?? [] : []);
  }
  if (url.includes("/rpc/acquire_finance_write_lock")) {
    if (world.lockHeld) return json(null);
    world.lockHeld = `lock-${++seq}`;
    return json(world.lockHeld);
  }
  if (url.includes("/rpc/release_finance_write_lock")) {
    const ok = body?.p_lock_token === world.lockHeld;
    if (ok) world.lockHeld = null;
    return json(ok);
  }
  const rpcMatch = /\/rpc\/(finance_supplier_[a-z_]+)$/.exec(url);
  if (rpcMatch) {
    world.rpcCalls++;
    try {
      return json(rpcFn(rpcMatch[1], body));
    } catch (e) {
      if (e instanceof Refused) return json({ code: "P0001", message: e.message }, 400);
      return json({ message: String(e) }, 400);
    }
  }
  if (url.includes("/rest/v1/")) return postgrest(url, method);
  if (url.startsWith("https://api.airtable.com/")) return airtable(url, method);
  return json({ error: "unexpected url" }, 598);
}) as typeof fetch;

export let rnd = 0;
export const deps: SupplierDeps = {
  airtable: { baseId: "appQktredAuGa1X7e", token: "pat-test" },
  grants: { supabaseUrl: "https://dkqubldmfyeuudecxmvh.supabase.co", serviceRoleKey: "service-role-test" },
  clock: () => NOW,
  suppliers: { random: () => (++rnd).toString(16).toUpperCase().padStart(12, "A") + "0000" },
};

// ----- request helpers (parse exactly as index.ts does, then orchestrate) -----
export const err = (p: any) => Promise.resolve({ status: "error", ...p } as any);
export const supplierNew = (body: Record<string, unknown>, caller: any = mgr): Promise<any> => {
  const p = parseSupplierCreate(JSON.stringify(body), isTenantKey);
  return p.ok ? createSupplier(deps, caller, p) : err(p);
};
export const supplierEdit = (id: string, body: Record<string, unknown>, caller: any = mgr): Promise<any> => {
  const p = parseSupplierUpdate(JSON.stringify(body), isTenantKey);
  return p.ok ? updateSupplier(deps, caller, id, p) : err(p);
};
export const agreementNew = (body: Record<string, unknown>, caller: any = mgr): Promise<any> => {
  const p = parseAgreement(JSON.stringify(body), isTenantKey, false);
  return p.ok ? createAgreement(deps, caller, p.supplierId as string, p.spec) : err(p);
};
export const agreementVersion = (id: string, body: Record<string, unknown>, caller: any = mgr): Promise<any> => {
  const p = parseAgreement(JSON.stringify(body), isTenantKey, true);
  return p.ok ? versionAgreement(deps, caller, id, p.spec) : err(p);
};
export const act = (id: string, action: InstalmentAction, body: Record<string, unknown>, caller: any = mgr): Promise<any> => {
  const p = parseAction(action, JSON.stringify(body), isTenantKey);
  return p.ok ? changeInstalmentAction(deps, caller, id, action, p.input) : err(p);
};
export const pay = (id: string, amount: string, paidDate = "2026-10-15", extra: Record<string, unknown> = {}) => act(id, "payment", { amount, paidDate, method: "bank_transfer", ...extra });
export const agreement = (id: string, caller: any = mgr) => readAgreement(deps, caller, id) as Promise<any>;
export const instalment = (id: string, caller: any = mgr) => readInstalment(deps, caller, id) as Promise<any>;
export const dbInst = (id: string) => T_("finance_supplier_instalments").find((x) => x.instalment_id === id) as Record<string, any>;
export const dbAgreement = (id: string) => T_("finance_supplier_agreements").find((x) => x.agreement_id === id) as Record<string, any>;
export const evTypes = (from: number) => world.audit.slice(from).map((e) => e.event_type);
export const snapshot = () => JSON.stringify({ sb: world.sb, audit: world.audit });
export const VENUE_BODY = (supplierId: string) => ({
  supplierId,
  name: "ZZTEST Hall hire autumn term",
  description: "Main hall Thursday evenings",
  costType: "custom_dates",
  classification: "direct",
  effectiveFrom: "2026-10-01",
  effectiveUntil: "2026-12-31",
  instalments: [
    { dueDate: "2026-11-20", amount: "500.00", note: "Second half" },
    { dueDate: "2026-10-20", amount: "500.00", note: "First half" },
  ],
  sessionIds: ["ZZ-VENUE-A"],
  sourceDocumentRef: "ZZTEST hall contract 2026-09-12.pdf",
});

// ----- F14 request helpers (parse exactly as index.ts does, then orchestrate) -----
export const creditNew = (body: Record<string, unknown>, caller: any = mgr): Promise<any> => {
  const p = parseCreditCreate(JSON.stringify(body), isTenantKey);
  return p.ok ? createCredit(deps, caller, p.input) : err(p);
};
export const creditDo = (id: string, action: CreditAction, body: Record<string, unknown>, caller: any = mgr): Promise<any> => {
  const p = parseCreditAction(action, JSON.stringify(body), isTenantKey);
  return p.ok ? creditAction(deps, caller, id, action, p.input) : err(p);
};
export const credit = (id: string, caller: any = mgr) => readCredit(deps, caller, id) as Promise<any>;
export const dbCredit = (id: string) => T_("finance_supplier_credits").find((x) => x.credit_id === id) as Record<string, any>;
export const dbApps = (creditId: string) => T_("finance_supplier_credit_applications").filter((x) => x.credit_id === creditId);
