/**
 * Finance Foundation F15 - overheads / contractors / salaries & employment costs.
 * Run: node --experimental-strip-types tests/support/finance-overheads.test.ts
 *
 *   CA  categories (create, read, duplicate / validation, organisation isolation)          brief 1-4
 *   OH  overhead history (fixed monthly, version keeps history, future version,
 *       annual / quarterly / one-off, inactive / end)                                       brief 5-9
 *   SA  salaries (create, effective-date change, prior history, coach cost 0.00, no
 *       session allocation)                                                                  brief 10-14
 *   ES  estimates (estimated, actual, Use Estimate, not Paid, duplicate safe)               brief 15-19
 *   PY  payment (explicit, paid date, no bank claim, duplicate protected)                   brief 20-23
 *   CT  contractors (F13-owned, read / categorised by F15, hours forecast, actual, no
 *       timesheet)                                                                           brief 24-27
 *   AC  access (View, Manage, no grant, coach / parent, module off, tenant)                  brief 28-33
 *   AU  audit (writes exact, reads / refusals none)                                          brief 34-35
 *   FA  reporting facts + expected payment date
 *   CC  concurrency (write lock, duplicate confirm / payment / version / category)
 *   DB  database backstops
 *   Z   code / drift checks against the canonical files
 *
 * The REAL F15 + F13 orchestrators and repositories run against the in-memory
 * world (finance-overheads-world.ts), whose fake database functions follow the
 * same rules as the TEST SQL (finance_f15_overheads_employment).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isTenantKey } from "./finance-access.ts";
import { workItemsOf } from "./finance-coach-costs.ts";
import { ITEM_ACTIONS, OVERHEAD_EVENTS, SUGGESTED_CATEGORIES, asInstalment, matchOverheadRoute, monthLine, monthlySalaryOf, parseCategory, parseEmploymentCreate, parseEmploymentVersion, parseOverheadQuery, payDateOf, planItemPayment } from "./finance-overheads.ts";
import { stateOf } from "./finance-suppliers.ts";
import {
  COACH_REC,
  MGR,
  ORG,
  R,
  T_,
  VENUE_BODY,
  act,
  agreementNew,
  agreementVersion,
  cat,
  catEdit,
  catNew,
  categorise,
  cats,
  ck,
  coach,
  dbInst,
  emp,
  empNew,
  empVersion,
  emps,
  facts,
  failed,
  mgr,
  monthAct,
  nogrant,
  ohRpcFn,
  overhead,
  overheadVersion,
  overheads,
  parent,
  pay,
  reset,
  snapshot,
  supplierNew,
  viewer,
  world,
  creditNew,
  creditDo,
  fake,
} from "./finance-overheads-world.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CANON = join(HERE, "..", "..", "supabase", "functions-test", "finance");
const added = async (fn: () => Promise<any>) => {
  const n = world.audit.length;
  const r = await fn();
  return { r, ev: world.audit.slice(n) };
};
const types = (ev: any[]) => ev.map((e) => e.event_type);
const row = (fs: any[], pred: (f: any) => boolean) => fs.find(pred);

async function main() {
  reset();
  // ===== fixtures (F13 suppliers + agreements, created through F13's own routes) =====
  const SW = (await supplierNew({ name: "ZZTEST Booking Software", type: "software_service", vatTreatment: "vat_included" })).body.supplier.supplierId as string;
  const INS = (await supplierNew({ name: "ZZTEST Insurer", type: "other", vatTreatment: "no_vat" })).body.supplier.supplierId as string;
  const ACC = (await supplierNew({ name: "ZZTEST Accountants", type: "other", vatTreatment: "plus_vat" })).body.supplier.supplierId as string;
  const MKT = (await supplierNew({ name: "ZZTEST Print Shop", type: "other" })).body.supplier.supplierId as string;
  const CON = (await supplierNew({ name: "ZZTEST Admin Contractor", type: "contractor" })).body.supplier.supplierId as string;
  const VEN = (await supplierNew({ name: "ZZTEST Venue Hall", type: "venue" })).body.supplier.supplierId as string;
  const s1 = await agreementNew({ supplierId: SW, name: "ZZTEST booking licence", costType: "fixed", frequency: "monthly", classification: "general", effectiveFrom: "2026-06-01", amount: "100.00", firstDueDate: "2026-06-28", instalmentCount: 12 });
  const S1 = s1.body.agreement.agreementId as string;
  const S1I = s1.body.schedule.map((i: any) => i.instalmentId as string);
  for (const k of [0, 1, 2, 3]) await pay(S1I[k], "100.00", s1.body.schedule[k].dueDate);
  const ins1 = await agreementNew({ supplierId: INS, name: "ZZTEST public liability", costType: "fixed", frequency: "annually", classification: "general", effectiveFrom: "2026-11-01", amount: "1200.00", firstDueDate: "2026-11-01", instalmentCount: 2 });
  const INS1 = ins1.body.agreement.agreementId as string;
  const q1 = await agreementNew({ supplierId: ACC, name: "ZZTEST quarterly bookkeeping", costType: "fixed", frequency: "quarterly", classification: "general", effectiveFrom: "2026-10-01", amount: "300.00", firstDueDate: "2026-10-31", instalmentCount: 4 });
  const Q1 = q1.body.agreement.agreementId as string;
  const o1 = await agreementNew({ supplierId: MKT, name: "ZZTEST flyers", costType: "one_off", classification: "general", effectiveFrom: "2026-11-01", amount: "250.00", firstDueDate: "2026-11-10" });
  const O1 = o1.body.agreement.agreementId as string;
  const u1 = await agreementNew({ supplierId: MKT, name: "ZZTEST banner (not yet categorised)", costType: "one_off", classification: "general", effectiveFrom: "2026-10-01", amount: "40.00", firstDueDate: "2026-10-20" });
  const U1 = u1.body.agreement.agreementId as string;
  const c1 = await agreementNew({ supplierId: CON, name: "ZZTEST admin support", costType: "hourly", classification: "general", effectiveFrom: "2026-10-01", hourlyRate: "20.00", expectedMonthlyHours: "10", firstDueDate: "2026-10-31", instalmentCount: 3 });
  const C1 = c1.body.agreement.agreementId as string;
  const C1I = c1.body.schedule.map((i: any) => i.instalmentId as string);
  const d1 = await agreementNew(VENUE_BODY(VEN));
  const D1 = d1.body.agreement.agreementId as string;
  ck("FX. Fixtures through F13: 6 suppliers; general monthly (12 x 100.00, Jun-Sep paid), annual, quarterly, one-off, uncategorised, hourly contractor; a direct venue agreement", [s1, ins1, q1, o1, u1, c1, d1].every((x) => x.httpStatus === 201) && S1I.length === 12 && dbInst(S1I[3]).paid_minor === 10000);

  // ===== CA. Categories =====
  const empty = await cats();
  ck("CA0. Nothing is seeded: no categories until Management adds one; the 10 baseline names are suggestions only", empty.httpStatus === 200 && empty.body.categories.length === 0 && empty.body.suggestions.length === 10 && empty.body.suggestions.join("|") === SUGGESTED_CATEGORIES.join("|") && T_("finance_overhead_categories").length === 0);
  const { r: soft, ev: softEv } = await added(() => catNew({ name: "Software", reason: "ZZTEST" }));
  const SOFT = soft.body.category.categoryId as string;
  ck("CA1. Create a category: 201, active, revision 1, one finance_overhead_category.created audit row", soft.httpStatus === 201 && soft.body.category.name === "Software" && soft.body.category.active === true && soft.body.category.revision === 1 && /^FOC-[0-9A-F]{12}$/.test(SOFT) && types(softEv).join() === OVERHEAD_EVENTS.categoryCreated);
  const id = async (name: string) => (await catNew({ name })).body.category.categoryId as string;
  const INSC = await id("Insurance"), ADM = await id("Admin / Contractors"), ACCT = await id("Accounting / Legal"), MKTG = await id("Marketing"), SAL = await id("Salaries & Employment Costs"), OTHER = await id("Other");
  const custom = await catNew({ name: "Coach Education" });
  const list = await cats();
  const one = await cat(SOFT);
  ck("CA2. Read: list shows every category (custom names allowed - nothing Josh-specific is hard-coded); suggestions drop names already used; one category returns its history", list.body.categories.length === 8 && list.body.categories.some((c: any) => c.name === "Coach Education") && list.body.suggestions.length === 3 && !list.body.suggestions.includes("Software") && one.httpStatus === 200 && one.body.history.length === 1 && one.body.history[0].event === OVERHEAD_EVENTS.categoryCreated && custom.httpStatus === 201);
  const a0 = world.audit.length;
  const r0 = world.rpcCalls;
  const dup = await catNew({ name: "  software " });
  const blank = await catNew({ name: "   " });
  const long = await catNew({ name: "x".repeat(101) });
  const extra = await catNew({ name: "Vehicles", colour: "red" });
  const renameClash = await catEdit(INSC, { name: "SOFTWARE" });
  const noop = await catEdit(INSC, { name: "Insurance" });
  const nothing = await catEdit(INSC, {});
  ck("CA3. Duplicate (case / space-insensitive) 409 category_exists; blank / too long / unknown field 400; rename onto another name 409; no-op 409; empty edit 400 - none audited", dup.code === "category_exists" && blank.code === "invalid_input" && long.code === "invalid_input" && extra.code === "unexpected_field" && renameClash.code === "category_exists" && noop.code === "nothing_to_change" && nothing.code === "invalid_input" && world.audit.length === a0 && world.rpcCalls === r0);
  T_("finance_overhead_categories").push({ organisation_id: "ORG-OTHER-002", category_id: "FOC-0THER0000001".replace("0THER", "ABCDE"), name: "Other Org Software", active: true, revision: 1, created_at: "2026-10-01T00:00:00.000Z", created_by: MGR, updated_at: "2026-10-01T00:00:00.000Z", updated_by: MGR });
  const iso1 = await cats();
  const iso2 = await cat("FOC-ABCDE0000001");
  const iso3 = await categorise({ agreementId: S1, categoryId: "FOC-ABCDE0000001" });
  ck("CA4. Organisation isolation: another organisation's category is never listed, read (404) or usable (404 category_not_found)", !iso1.body.categories.some((c: any) => c.name === "Other Org Software") && iso2.code === "category_not_found" && iso3.code === "category_not_found");

  // ===== OH. Overhead history (F13 general agreements + an F15 category) =====
  const { r: catS1, ev: catS1Ev } = await added(() => categorise({ agreementId: S1, categoryId: SOFT, reason: "ZZTEST licence is software" }));
  const oct = await overheads({ month: "2026-10" });
  const softGroup = oct.body.categories.find((g: any) => g.category.categoryId === SOFT);
  ck("OH5. Fixed monthly overhead: categorising the F13 general agreement shows it under Software with October's 100.00 from F13's schedule (one audit row; F13 rows untouched)", catS1.httpStatus === 201 && catS1.body.overhead.category.category === "Software" && softGroup.overheads.length === 1 && softGroup.overheads[0].month.due === "100.00" && softGroup.monthTotal === "100.00" && types(catS1Ev).join() === OVERHEAD_EVENTS.categorised && T_("finance_overhead_assignments").length === 1);
  const past = await overheadVersion(S1, { name: "ZZTEST booking licence (price rise)", costType: "fixed", frequency: "monthly", classification: "general", effectiveFrom: "2026-09-01", amount: "120.00", firstDueDate: "2026-09-28", instalmentCount: 9, reason: "ZZTEST backdated rise" });
  ck("OH6a. A version reaching back over a paid month is refused by F13's own rule (409 paid_instalment_after_change) - history is never rewritten", past.code === "paid_instalment_after_change" && T_("finance_overhead_assignments").length === 1);
  const { r: v2, ev: v2Ev } = await added(() => overheadVersion(S1, { name: "ZZTEST booking licence (price rise)", costType: "fixed", frequency: "monthly", classification: "general", effectiveFrom: "2026-11-01", amount: "120.00", firstDueDate: "2026-11-28", instalmentCount: 7, reason: "ZZTEST new tier from November" }));
  const S2 = v2.body.agreement?.agreementId as string;
  const s1Rows = T_("finance_supplier_instalments").filter((i) => i.agreement_id === S1);
  ck("OH6. Version from November: June-October stay 100.00 (4 paid + October open); the predecessor's Nov-May instalments are cancelled by F13, never rewritten", v2.httpStatus === 201 && s1Rows.filter((i) => i.cancelled_at === null).map((i) => `${i.due_date}:${i.amount_due_minor}`).join() === "2026-06-28:10000,2026-07-28:10000,2026-08-28:10000,2026-09-28:10000,2026-10-28:10000" && s1Rows.filter((i) => i.cancelled_at !== null).length === 7 && s1Rows.every((i) => i.amount_due_minor === 10000));
  const nov = await overheads({ month: "2026-11" });
  const softNov = nov.body.categories.find((g: any) => g.category.categoryId === SOFT);
  ck("OH7. Future version applies: November shows the new version's 120.00 under the same category (carried from the version it replaces), recorded atomically with F13's version + one finance_overhead.versioned row", softNov.overheads.find((o: any) => o.agreement.agreementId === S2).month.due === "120.00" && softNov.overheads.find((o: any) => o.agreement.agreementId === S1).month.due === "0.00" && v2.body.category.categoryId === SOFT && types(v2Ev).filter((t) => t === OVERHEAD_EVENTS.versioned).length === 1 && types(v2Ev).includes("finance_supplier_agreement.versioned") && types(v2Ev).filter((t) => t === "finance_supplier_instalment.cancelled").length === 7);
  const v3 = await overheadVersion(S2, { name: "ZZTEST booking licence (moved to Other)", costType: "fixed", frequency: "monthly", classification: "general", effectiveFrom: "2027-02-01", amount: "120.00", firstDueDate: "2027-02-28", instalmentCount: 4, categoryId: OTHER, reason: "ZZTEST recategorise from February" });
  const S3 = v3.body.agreement?.agreementId as string;
  const chain = await overhead(S3);
  ck("OH7b. Recategorising from a later date is a new version: S1 / S2 keep Software, S3 is Other - each version's category is fixed", v3.httpStatus === 201 && chain.body.versions.map((x: any) => x.category.name).join() === "Software,Software,Other" && chain.body.versions.length === 3 && (await categorise({ agreementId: S2, categoryId: OTHER })).code === "already_categorised");
  for (const [a, c] of [[INS1, INSC], [Q1, ACCT], [O1, MKTG], [C1, ADM]]) await categorise({ agreementId: a, categoryId: c });
  const f8 = (await facts({ fromMonth: "2026-10", toMonth: "2027-01" })).body.facts;
  ck("OH8. Annual / quarterly / one-off: insurance 1,200.00 in Nov (annual), bookkeeping 300.00 on 31 Oct + 31 Jan (quarterly), flyers 250.00 on 10 Nov (one-off) - each from F13's schedule under its category", row(f8, (f: any) => f.source.agreementId === INS1 && f.period === "2026-11")?.amount === "1200.00" && f8.filter((f: any) => f.source.agreementId === INS1).length === 1 && f8.filter((f: any) => f.source.agreementId === Q1).map((f: any) => f.expectedPaymentDate).join() === "2026-10-31,2027-01-31" && row(f8, (f: any) => f.source.agreementId === O1)?.expectedPaymentDate === "2026-11-10" && row(f8, (f: any) => f.source.agreementId === O1)?.category.name === "Marketing");
  const deact = await catEdit(MKTG, { active: false, reason: "ZZTEST no longer used" });
  const r9 = world.rpcCalls;
  const useInactive = await categorise({ agreementId: U1, categoryId: MKTG });
  const verInactive = await overheadVersion(O1, { name: "ZZTEST flyers reprint", costType: "one_off", classification: "general", effectiveFrom: "2026-12-01", amount: "260.00", firstDueDate: "2026-12-10", reason: "ZZTEST" });
  const onlyInactive = await cats({ active: false });
  const r9b = world.rpcCalls;
  const keep = row((await facts({ fromMonth: "2026-11", toMonth: "2026-11" })).body.facts, (f: any) => f.source.agreementId === O1);
  const react = await catEdit(MKTG, { active: true });
  const ended = await agreementNew({ supplierId: MKT, name: "ZZTEST old ad slot", costType: "fixed", frequency: "monthly", classification: "general", effectiveFrom: "2026-06-01", effectiveUntil: "2026-08-31", amount: "10.00", firstDueDate: "2026-06-30" });
  await categorise({ agreementId: ended.body.agreement.agreementId, categoryId: MKTG });
  const endedRow = (await overheads({ month: "2026-10" })).body.categories.find((g: any) => g.category.categoryId === MKTG).overheads.find((o: any) => o.agreement.agreementId === ended.body.agreement.agreementId);
  ck("OH9. Inactive / end: a deactivated category takes nothing new (409 category_inactive) but existing overheads keep it; reactivation works; an ended F13 agreement shows status ended with nothing due", deact.httpStatus === 200 && deact.body.category.active === false && useInactive.code === "category_inactive" && verInactive.code === "category_inactive" && r9b === r9 && onlyInactive.body.categories.map((c: any) => c.name).join() === "Marketing" && keep.category.name === "Marketing" && keep.category.active === false && react.body.category.active === true && endedRow.agreement.status === "ended" && endedRow.month.due === "0.00");
  const r9c = world.rpcCalls;
  const notOver = await categorise({ agreementId: D1, categoryId: OTHER });
  const notOverRead = await overhead(D1);
  const notOverVer = await overheadVersion(D1, { name: "ZZTEST hall as general", costType: "one_off", classification: "general", effectiveFrom: "2026-12-01", amount: "1.00", firstDueDate: "2026-12-01", categoryId: OTHER, reason: "x" });
  const directVer = await overheadVersion(S3, { name: "ZZTEST direct", costType: "one_off", classification: "direct", effectiveFrom: "2027-06-01", effectiveUntil: "2027-06-30", amount: "1.00", firstDueDate: "2027-06-01", sessionIds: ["ZZ-VENUE-A"], reason: "x" });
  ck("OH9b. Direct costs are not overheads: categorising or reading a direct venue agreement is refused (409 / 404 not_an_overhead); F13 keeps it as a session cost", notOver.code === "not_an_overhead" && notOverRead.code === "not_an_overhead" && notOverVer.code === "not_an_overhead" && directVer.code === "invalid_input" && directVer.fields?.classification && world.rpcCalls === r9c);

  // ===== SA. Salaried employees (F15's own ledger) =====
  const { r: e1, ev: e1Ev } = await added(() => empNew({ personRef: "COACH-SAL-1", categoryId: SAL, annualSalary: "30000.00", payDay: 28, startDate: "2026-09-01", employerPensionMonthlyEstimate: "75.00", employerNiPayeMonthlyEstimate: "210.00", reason: "ZZTEST salaried coach" }));
  const E1 = e1.body.employment?.employmentId as string;
  ck("SA10. Create a salaried employee cost: person from Coaches (Coach ID -> name), 30,000.00 / year = 2,500.00 / month, pay day 28, pension + NI / PAYE as labelled Management-entered estimates; one audit row", e1.httpStatus === 201 && e1.body.employment.person.name === "ZZTEST Salaried Coach" && e1.body.employment.person.ref === "COACH-SAL-1" && e1.body.employment.monthlySalary === "2500.00" && e1.body.employment.employerPensionMonthlyEstimate === "75.00" && /Management-entered estimate/.test(e1.body.employment.estimatesAre) && types(e1Ev).join() === OVERHEAD_EVENTS.employmentCreated && e1.body.nextMonths[0].estimateTotal === "2785.00");
  const formulaOk = /\{Coach ID\}='COACH-SAL-1'/.test(fake.lastCoachesUrl);
  const r10 = world.rpcCalls;
  const e1dup = await empNew({ personRef: "COACH-SAL-1", categoryId: SAL, annualSalary: "1.00", payDay: 1, startDate: "2026-09-01" });
  const amb = await empNew({ personRef: "COACH-DUP", categoryId: SAL, annualSalary: "1.00", payDay: 1, startDate: "2026-09-01" });
  const none = await empNew({ personRef: "COACH-NONE", categoryId: SAL, annualSalary: "1.00", payDay: 1, startDate: "2026-09-01" });
  const noName = await empNew({ categoryId: SAL, annualSalary: "1.00", payDay: 1, startDate: "2026-09-01" });
  const badDay = await empNew({ name: "X", categoryId: SAL, annualSalary: "1.00", payDay: 32, startDate: "2026-09-01" });
  fake.coachesIgnoreFormula = true;
  const looseNone = await empNew({ personRef: "COACH-NONE", categoryId: SAL, annualSalary: "1.00", payDay: 1, startDate: "2026-09-01" });
  fake.coachesIgnoreFormula = false;
  ck("SA10b. Refusals: same person twice 409 employment_exists; ambiguous Coach ID 409; unknown Coach ID 404; no name without a person 400; pay day 32 400", e1dup.code === "employment_exists" && amb.code === "person_ambiguous" && none.code === "person_not_found" && noName.code === "invalid_input" && badDay.code === "invalid_input" && !!badDay.fields?.payDay && world.rpcCalls === r10 && formulaOk && looseNone.code === "person_not_found");
  const e2 = await empNew({ name: "ZZTEST Office Manager", categoryId: SAL, annualSalary: "24000.00", payDay: 31, startDate: "2026-10-20", notes: "ZZTEST part month in October" });
  const E2 = e2.body.employment.employmentId as string;
  const e2v = (await emp(E2, { fromMonth: "2026-09", toMonth: "2026-11" })).body.months;
  ck("SA10c. Employee without a person reference; months before the start do not exist; October is flagged part-month (estimate is a full month - confirm the actual); pay day 31 falls on 30 November", e2.httpStatus === 201 && e2v.map((x: any) => `${x.month}:${x.expectedPaymentDate}:${x.partMonth}`).join() === "2026-10:2026-10-31:true,2026-11:2026-11-30:false" && (await empNew({ name: "zztest office manager", categoryId: SAL, annualSalary: "1.00", payDay: 1, startDate: "2026-09-01" })).code === "employment_exists");

  // ===== ES. Estimates =====
  const octLine = (await emp(E1, { fromMonth: "2026-10", toMonth: "2026-10" })).body.months[0];
  ck("ES15. Estimated amount: October is 2,500.00 + 75.00 + 210.00 = 2,785.00, state Estimated, nothing confirmed or paid", octLine.state === "estimated" && octLine.estimateTotal === "2785.00" && octLine.salary === "2500.00" && octLine.amountIsEstimate === true && octLine.itemId === null && octLine.paid === "0.00" && T_("finance_employment_items").length === 0);
  const { r: useEst, ev: useEstEv } = await added(() => monthAct(E1, "2026-10", "confirm-estimate", { useEstimate: true }));
  ck("ES17. Use Estimate: the 2,785.00 estimate becomes the confirmed amount due", useEst.httpStatus === 200 && useEst.body.month.state === "confirmed" && useEst.body.month.amountDue === "2785.00" && useEst.body.month.usedEstimate === true && types(useEstEv).join() === OVERHEAD_EVENTS.itemConfirmed && useEstEv[0].after.usedEstimate === true);
  ck("ES18. Confirming is not paying: paid 0.00, remaining 2,785.00, no paid date, no payment, Paid still a separate action", useEst.body.month.paid === "0.00" && useEst.body.month.remaining === "2785.00" && useEst.body.month.paidDate === null && useEst.body.month.payment === null && /Paid is a separate action/.test(useEst.body.note) && useEstEv[0].after.paidStateUnchanged === true);
  const { r: actual, ev: actualEv } = await added(() => monthAct(E1, "2026-11", "confirm-estimate", { amount: "2650.00", reason: "ZZTEST unpaid day" }));
  ck("ES16. Confirm the actual: November 2,650.00 replaces the 2,785.00 estimate (kept on the month and in the audit row)", actual.body.month.amountDue === "2650.00" && actual.body.month.estimateTotal === "2785.00" && actual.body.month.usedEstimate === false && actualEv[0].before.estimateTotal === "2785.00" && actualEv[0].after.confirmed === "2650.00" && actualEv[0].reason === "ZZTEST unpaid day");
  const a19 = world.audit.length;
  const r19 = world.rpcCalls;
  const again = await monthAct(E1, "2026-10", "confirm-estimate", { amount: "1.00" });
  const both = await monthAct(E1, "2026-12", "confirm-estimate", { amount: "1.00", useEstimate: true });
  const neither = await monthAct(E1, "2026-12", "confirm-estimate", {});
  const before = await monthAct(E1, "2026-08", "confirm-estimate", { useEstimate: true });
  ck("ES19. Duplicate confirmation is safe: a confirmed month refuses another (409 already_confirmed, amount unchanged); amount AND useEstimate / neither 400; before the start 409 month_not_employed - none audited", again.code === "already_confirmed" && T_("finance_employment_items").find((i) => i.month === "2026-10").amount_due_minor === 278500 && both.code === "invalid_input" && neither.code === "invalid_input" && before.code === "month_not_employed" && world.audit.length === a19 && world.rpcCalls === r19);

  // ===== SA. Effective-date history =====
  const r11 = world.rpcCalls;
  const early = await empVersion(E1, { effectiveFromMonth: "2026-11", annualSalary: "33000.00", reason: "ZZTEST rise" });
  const r11b = world.rpcCalls;
  const { r: rise, ev: riseEv } = await added(() => empVersion(E1, { effectiveFromMonth: "2026-12", annualSalary: "33000.00", reason: "ZZTEST pay rise from December" }));
  const hist = (await emp(E1, { fromMonth: "2026-09", toMonth: "2027-01" })).body;
  ck("SA11. Effective-date change: a rise from December makes December 2,750.00 + 285.00 = 3,035.00 (estimated) and is one finance_employment_cost.versioned row; a version reaching back over a confirmed month is refused (409 confirmed_month_after_change)", early.code === "confirmed_month_after_change" && r11b === r11 && rise.httpStatus === 201 && rise.body.firstMonth.estimateTotal === "3035.00" && rise.body.monthBefore.amountDue === "2650.00" && types(riseEv).join() === OVERHEAD_EVENTS.employmentVersioned && riseEv[0].after.changed.join() === "annualSalaryMinor" && hist.versions.length === 2);
  ck("SA12. Prior history unchanged: September 2,500.00 (estimate under the first version), October 2,785.00 confirmed, November 2,650.00 confirmed; the old terms stay readable", hist.months.map((x: any) => `${x.month}:${x.salary}:${x.amountDue}:${x.state}`).join() === "2026-09:2500.00:2785.00:estimated,2026-10:2500.00:2785.00:confirmed,2026-11:2500.00:2650.00:confirmed,2026-12:2750.00:3035.00:estimated,2027-01:2750.00:3035.00:estimated" && hist.versions[0].annualSalary === "30000.00" && hist.versions[1].effectiveFromMonth === "2026-12");
  const r12 = world.rpcCalls;
  const samePrev = await empVersion(E1, { effectiveFromMonth: "2026-12", payDay: 27, reason: "ZZTEST" });
  const nochange = await empVersion(E1, { effectiveFromMonth: "2027-03", annualSalary: "33000.00", reason: "ZZTEST" });
  const noReason = await empVersion(E1, { effectiveFromMonth: "2027-03", annualSalary: "34000.00" });
  const startFixed = await empVersion(E1, { effectiveFromMonth: "2027-03", startDate: "2026-08-01", reason: "x" });
  ck("SA12b. A version must start after the latest one (409 version_must_start_later); nothing-changed 409; reason required; start date and person are fixed (400 unexpected_field)", samePrev.code === "version_must_start_later" && nochange.code === "nothing_to_change" && noReason.code === "invalid_input" && startFixed.code === "unexpected_field" && world.rpcCalls === r12);
  const cw = {
    allocations: [{ id: "recALLOCSAL00001", fields: { "Allocation ID": "ALLOC-SAL-1", "Session Occurrence": ["recOCCSAL0000001"], Coach: [COACH_REC], "Cost Status": "Confirmed", "Cost Basis": "Salaried — no direct session cost", "Final Coach Cost": 0 } }],
    occurrences: new Map([["recOCCSAL0000001", { id: "recOCCSAL0000001", fields: { "Occurrence ID": "OCC-SAL", Date: "2026-10-05", Status: "Completed", Session: [] } }]]),
    sessions: new Map(),
    workers: [],
    lines: new Map(),
    summaries: new Map(),
  };
  const wi = workItemsOf(cw as any, COACH_REC, "2026-10-01", "2026-10-31", "2026-10-15")[0];
  const cwBad = { ...cw, allocations: [{ ...cw.allocations[0], fields: { ...cw.allocations[0].fields, "Final Coach Cost": 25 } }] };
  const wiBad = workItemsOf(cwBad as any, COACH_REC, "2026-10-01", "2026-10-31", "2026-10-15")[0];
  ck("SA13. Direct Coach Cost stays 0.00: F12 reads the salaried coach's session as Cost Basis Salaried with a 0.00 direct cost (a non-zero cost is an F12 blocker); the employment record says so and F15 never writes Coach Allocations", wi.costBasis === "salaried" && wi.finalCostMinor === 0 && !wi.blockers.some((b: any) => b.code === "no_cost_basis_with_cost") && wiBad.blockers.some((b: any) => b.code === "no_cost_basis_with_cost") && hist.directSessionCost.amount === "0.00" && world.airtableWrites === 0);
  const fx = (await facts({ fromMonth: "2026-10", toMonth: "2026-12" })).body;
  const empRows = fx.facts.filter((f: any) => f.sourceType === "employment");
  ck("SA14. No session salary allocation: employment facts carry no session / occurrence / programme / Finance Service attribution and F15 only ever reads Coaches from Airtable", empRows.length > 0 && empRows.every((f: any) => !("sessionId" in f) && !("financeServiceId" in f) && !("programme" in f) && !("occurrence" in f)) && world.airtableReads.filter((t) => !["Feature Controls", "Organisation & Branding", "Sessions", "Session Occurrences", "Venues"].includes(t)).every((t) => t === "Coaches"));

  // ===== PY. Payment (full only, Management-confirmed) =====
  const estPay = await monthAct(E1, "2026-12", "payment", { amount: "3035.00", paidDate: "2026-10-15" });
  const { r: paid, ev: paidEv } = await added(() => monthAct(E1, "2026-10", "payment", { amount: "2785.00", paidDate: "2026-10-14", method: "bank_transfer", reference: "ZZTEST PAYRUN OCT" }));
  ck("PY20. Explicit payment: October (confirmed 2,785.00) recorded paid in full by Management; an Estimated month cannot be paid (409 amount_still_estimated)", estPay.code === "amount_still_estimated" && paid.httpStatus === 201 && paid.body.month.state === "paid" && paid.body.month.paid === "2785.00" && paid.body.month.remaining === "0.00" && types(paidEv).join() === OVERHEAD_EVENTS.itemPaid);
  const futurePay = await monthAct(E1, "2026-11", "payment", { amount: "2650.00", paidDate: "2026-10-16" });
  ck("PY21. Paid date stored as given (2026-10-14) on the month, its payment and the audit row; a future paid date 400", T_("finance_employment_items").find((i) => i.month === "2026-10").paid_date === "2026-10-14" && paid.body.month.paidDate === "2026-10-14" && paid.body.month.payment.paidDate === "2026-10-14" && paidEv[0].after.payment.paidDate === "2026-10-14" && futurePay.code === "invalid_input");
  ck("PY22. No bank reconciliation claim: the payment is Management-confirmed (source management_confirmed) and says it is not a bank reconciliation; no bank fields exist", paid.body.month.payment.source === "management_confirmed" && /not a bank reconciliation/.test(paid.body.note) && !Object.keys(T_("finance_employment_items")[0]).some((k) => /bank|reconcil|statement/.test(k)));
  const a23 = world.audit.length;
  const r23 = world.rpcCalls;
  const twice = await monthAct(E1, "2026-10", "payment", { amount: "2785.00", paidDate: "2026-10-14" });
  const partial = await monthAct(E1, "2026-11", "payment", { amount: "1000.00", paidDate: "2026-10-14" });
  const over = await monthAct(E1, "2026-11", "payment", { amount: "2650.01", paidDate: "2026-10-14" });
  const reconfirmPaid = await monthAct(E1, "2026-10", "confirm-estimate", { amount: "1.00" });
  ck("PY23. Duplicate payment protected: paying October again 409 already_paid; partial 409 partial_payment_not_supported; over 409 - none audited, October paid once", twice.code === "already_paid" && partial.code === "partial_payment_not_supported" && over.code === "partial_payment_not_supported" && reconfirmPaid.code === "already_confirmed" && world.audit.length === a23 && world.rpcCalls === r23 && T_("finance_employment_items").find((i) => i.month === "2026-10").paid_minor === 278500);

  // ===== CT. Contractors stay F13's =====
  const f15Tables = () => JSON.stringify(["finance_overhead_categories", "finance_overhead_assignments", "finance_employment_versions", "finance_employment_items"].map((t) => T_(t).length));
  const oh24 = await overhead(C1);
  ck("CT24. Non-Coach contractor: an F13 contractor supplier's general agreement, categorised Admin / Contractors and surfaced as an overhead; F15 has no contractor table or route", oh24.httpStatus === 200 && oh24.body.overhead.contractor === true && oh24.body.overhead.supplier.type === "contractor" && oh24.body.overhead.category.category === "Admin / Contractors" && !Object.keys(world.sb).some((t) => /contractor/.test(t)) && matchOverheadRoute("contractors", "GET") === null && matchOverheadRoute("overheads/contractors", "GET")?.status === "not_found");
  ck("CT25. Expected monthly hours forecast: 20.00 x 10.00 h = 200.00 per month, Estimated, read from F13 (hours, rate and schedule are F13's)", oh24.body.overhead.hourlyForecast.hourlyRate === "20.00" && oh24.body.overhead.hourlyForecast.expectedMonthlyHours === "10.00" && oh24.body.schedule.every((i: any) => i.amountDue === "200.00" && i.state === "estimated"));
  const f15Before = f15Tables();
  const { r: conf26, ev: conf26Ev } = await added(() => act(C1I[0], "confirm-estimate", { amount: "180.00" }));
  const c26 = row((await facts({ fromMonth: "2026-10", toMonth: "2026-10" })).body.facts, (f: any) => f.source.instalmentId === C1I[0]);
  ck("CT26. Confirmed monthly actual: ONE amount (180.00) confirmed on the F13 instalment (F13 audit only); F15 facts show it confirmed under Admin / Contractors; no F15 row written", conf26.httpStatus === 200 && types(conf26Ev).join() === "finance_supplier_instalment.estimate_confirmed" && c26.amount === "180.00" && c26.state === "confirmed" && c26.category.name === "Admin / Contractors" && c26.contractor === true && f15Tables() === f15Before);
  const ts = parseEmploymentCreate(JSON.stringify({ name: "X", categoryId: SAL, annualSalary: "1.00", payDay: 1, startDate: "2026-09-01", hours: 10 }), isTenantKey) as any;
  ck("CT27. No daily timesheet requirement: confirming needs one monthly amount; no timesheet / hours-per-day field or route exists anywhere in F15", c26.hourlyForecast.timesheetsRequired === false && ts.code === "unexpected_field" && matchOverheadRoute(`employment-costs/${E1}/timesheets`, "POST")?.status === "not_found" && matchOverheadRoute(`overheads/${C1}/timesheet`, "POST")?.status === "not_found");

  // ===== FA. Reporting facts =====
  const F = (await facts({ fromMonth: "2026-10", toMonth: "2026-12" })).body;
  const sOct = row(F.facts, (f: any) => f.source.agreementId === S1 && f.period === "2026-10");
  const insNov = row(F.facts, (f: any) => f.source.agreementId === INS1);
  const qOct = row(F.facts, (f: any) => f.source.agreementId === Q1 && f.period === "2026-10");
  const uRow = row(F.facts, (f: any) => f.source.agreementId === U1);
  const eOct = row(F.facts, (f: any) => f.sourceType === "employment" && f.person.employmentId === E1 && f.period === "2026-10");
  const eDec = row(F.facts, (f: any) => f.sourceType === "employment" && f.person.employmentId === E1 && f.period === "2026-12");
  ck("FA1. Facts carry organisation, category, payee / person, period, amount, gross / VAT / net only where known, state, expected payment date, paid date and source type", F.facts.every((f: any) => f.organisationId === ORG && "category" in f && "period" in f && "state" in f && ["supplier_agreement", "supplier_credit", "employment"].includes(f.sourceType)) && sOct.payee.name === "ZZTEST Booking Software" && sOct.vatTreatment === "vat_included" && sOct.gross === "100.00" && sOct.vat === null && sOct.net === null && insNov.vat === "0.00" && insNov.net === "1200.00" && qOct.net === "300.00" && qOct.gross === null);
  ck("FA2. Employment facts: person, category, 2,785.00 paid on 2026-10-14 (October), December estimated 3,035.00 with components; no VAT on salary", eOct.person.name === "ZZTEST Salaried Coach" && eOct.category.name === "Salaries & Employment Costs" && eOct.state === "paid" && eOct.paidDate === "2026-10-14" && eOct.expectedPaymentDate === "2026-10-28" && eOct.vatTreatment === "not_applicable" && eOct.gross === "2785.00" && eOct.vat === "0.00" && eDec.state === "estimated" && eDec.amount === "3035.00" && eDec.components.salary === "2750.00");
  ck("FA3. Uncategorised general agreements still appear (category null) and are listed for Management to categorise; direct agreements never appear in overhead facts", uRow.category === null && (await overheads()).body.uncategorised.some((o: any) => o.agreement.agreementId === U1) && !F.facts.some((f: any) => f.source.agreementId === D1) && F.byCategory.some((b: any) => b.categoryId === null));
  ck("FA4. Expected payment date (future Cash Flow input): every row has one; a paid supplier month carries its paid date; nothing creates a Cash Flow event", F.facts.filter((f: any) => f.sourceType !== "supplier_credit").every((f: any) => /^\d{4}-\d{2}-\d{2}$/.test(f.expectedPaymentDate)) && row((await facts({ fromMonth: "2026-09", toMonth: "2026-09" })).body.facts, (f: any) => f.source.agreementId === S1).paidDate === "2026-09-28" && !/cash ?flow event/i.test(JSON.stringify(Object.keys(F))));
  const cancelledIds = new Set(T_("finance_supplier_instalments").filter((i) => i.cancelled_at !== null).map((i) => i.instalment_id));
  ck("FA3b. Cancelled (superseded) F13 instalments never appear in overhead facts or month totals: November has S2's 120.00 only, never S1's cancelled 100.00", cancelledIds.size >= 7 && !F.facts.some((f: any) => cancelledIds.has(f.source.instalmentId)) && F.facts.filter((f: any) => f.period === "2026-11" && [S1, S2].includes(f.source.agreementId)).map((f: any) => f.amount).join() === "120.00");
  const kq = await creditNew({ supplierId: ACC, scope: "agreement", agreementId: Q1, amount: "50.00", creditDate: "2026-10-10", sourceType: "credit_note", sourceReference: "ZZ-ACC-CN1", reason: "ZZTEST fee reduction" });
  const kv = await creditNew({ supplierId: ACC, scope: "agreement", agreementId: Q1, amount: "5.00", creditDate: "2026-10-11", sourceType: "credit_note", sourceReference: "ZZ-ACC-CN2", reason: "ZZTEST entered twice" });
  await creditDo(kv.body.credit.creditId, "void", { reason: "ZZTEST entered in error" });
  const kd = await creditNew({ supplierId: VEN, scope: "agreement", agreementId: D1, amount: "20.00", creditDate: "2026-10-12", sourceType: "credit_note", sourceReference: "ZZ-VEN-CN1", reason: "ZZTEST hall credit" });
  const kRows = (await facts({ fromMonth: "2026-10", toMonth: "2026-10" })).body.facts.filter((f: any) => f.sourceType === "supplier_credit");
  ck("FA3c. F14 supplier credits on a categorised general agreement appear as separate negative cost adjustments under its category; voided credits and credits on direct agreements never do", kq.httpStatus === 201 && kd.httpStatus === 201 && kRows.length === 1 && kRows[0].amount === "-50.00" && kRows[0].category.name === "Accounting / Legal" && kRows[0].source.creditId === kq.body.credit.creditId);
  const badRange = parseOverheadQuery("facts", new URLSearchParams("from=2026-01&to=2027-06"), isTenantKey);
  const badRange2 = await facts({ fromMonth: "2026-01", toMonth: "2027-06" });
  ck("FA5. Range: default the 3 months ending this month; at most 12 months (400)", badRange.ok === true && badRange2.code === "invalid_query" && (await facts()).body.from === "2026-08" && (await facts()).body.to === "2026-10");

  // ===== CC. Concurrency =====
  {
    const snap = snapshot();
    world.lockHeld = "someone-else";
    const busy = [await catNew({ name: "Vehicles" }), await categorise({ agreementId: U1, categoryId: MKTG }), await monthAct(E2, "2026-11", "confirm-estimate", { useEstimate: true }), await empVersion(E2, { effectiveFromMonth: "2026-12", endDate: "2026-12-15", reason: "x" })];
    world.lockHeld = null;
    ck("CC1. Under the shared Finance write lock: while another change holds it every F15 write is 409 finance_commercial_busy and nothing changes", busy.every((b) => b.code === "finance_commercial_busy") && snapshot() === snap);
    const [x1, x2] = await Promise.all([monthAct(E2, "2026-11", "confirm-estimate", { useEstimate: true }), monthAct(E2, "2026-11", "confirm-estimate", { amount: "1.00" })]);
    ck("CC2. Two simultaneous confirmations of one month: exactly one succeeds, the other is refused (busy / already confirmed); one item row", [x1, x2].filter((x) => x.status === "ok").length === 1 && [x1, x2].filter((x) => x.status === "error").every((x) => ["finance_commercial_busy", "already_confirmed"].includes(x.code)) && T_("finance_employment_items").filter((i) => i.employment_id === E2 && i.month === "2026-11").length === 1);
    const [p1, p2] = await Promise.all([monthAct(E2, "2026-11", "payment", { amount: "2000.00", paidDate: "2026-10-15" }), monthAct(E2, "2026-11", "payment", { amount: "2000.00", paidDate: "2026-10-15" })]);
    ck("CC3. Two simultaneous payments: one recorded, the other refused (busy / already paid) - never a duplicate payment", [p1, p2].filter((x) => x.status === "ok").length === 1 && [p1, p2].filter((x) => x.status === "error").every((x) => ["finance_commercial_busy", "already_paid"].includes(x.code)));
    const [k1, k2] = await Promise.all([empVersion(E2, { effectiveFromMonth: "2026-12", endDate: "2026-12-15", reason: "ZZTEST leaving" }), empVersion(E2, { effectiveFromMonth: "2026-12", annualSalary: "25000.00", reason: "ZZTEST rise" })]);
    ck("CC4. Two simultaneous versions: exactly one is stored; version history is never overwritten or forked", [k1, k2].filter((x) => x.status === "ok").length === 1 && T_("finance_employment_versions").filter((v) => v.employment_id === E2).length === 2);
    const [g1, g2] = await Promise.all([categorise({ agreementId: U1, categoryId: MKTG }), categorise({ agreementId: U1, categoryId: OTHER })]);
    ck("CC5. Two simultaneous categorisations of one agreement version: one category, fixed", [g1, g2].filter((x) => x.status === "ok").length === 1 && T_("finance_overhead_assignments").filter((a) => a.agreement_id === U1).length === 1);
    const race = await agreementVersion(S3, { name: "ZZTEST other", costType: "fixed", frequency: "monthly", classification: "general", effectiveFrom: "2027-04-01", amount: "1.00", firstDueDate: "2027-04-28", instalmentCount: 1, reason: "x" });
    const lost = await overheadVersion(S3, { name: "ZZTEST lost race", costType: "fixed", frequency: "monthly", classification: "general", effectiveFrom: "2027-04-01", amount: "1.00", firstDueDate: "2027-04-28", instalmentCount: 1, reason: "x" });
    ck("CC6. An F13 version made directly is simply uncategorised until Management categorises it; a second version of the same agreement via F15 is refused (409 agreement_already_versioned)", race.httpStatus === 201 && (await overhead(race.body.agreement.agreementId)).body.overhead.category === null && lost.code === "agreement_already_versioned");
  }
  const endE2 = (await emp(E2, { fromMonth: "2026-11", toMonth: "2027-01" })).body;
  const ended2 = endE2.versions.length === 2 && endE2.versions[1].endDate === "2026-12-15";
  const beyond = ended2 ? await monthAct(E2, "2027-01", "confirm-estimate", { useEstimate: true }) : { code: "skipped" };
  const r9d = world.rpcCalls;
  const endTooEarly = await empVersion(E2, { effectiveFromMonth: "2027-02", endDate: "2026-12-31", reason: "x" });
  const r9e = world.rpcCalls;
  ck("OH9c. Employment end: when the leaving version won, December is a part month and January has no cost (409 month_not_employed); an end date before the version's start month is refused", (!ended2 || (endE2.months.find((x: any) => x.month === "2026-12").partMonth === true && !endE2.months.some((x: any) => x.month === "2027-01") && beyond.code === "month_not_employed")) && endTooEarly.code === "end_before_version_start" && r9e === r9d);

  // ===== DB. Database backstops (the fake functions follow the TEST SQL) =====
  {
    const rpcErr = (fn: string, a: any) => {
      try {
        ohRpcFn(fn, a);
        return "ALLOWED";
      } catch (e) {
        return String((e as Error).message);
      }
    };
    const it = T_("finance_employment_items").find((i) => i.employment_id === E1 && i.month === "2026-10");
    ck("DB1. A second confirm of a month (fresh item id) is refused by the database (f15:already_confirmed)", rpcErr("finance_employment_item_change", { p_kind: "confirm", p_item: { ...T_("finance_employment_items").find((i) => i.month === "2026-11" && i.employment_id === E1), item_id: "FEI-AAAAAAAAAAA9" }, p_expected: null, p_events: [{}] }) === "f15:already_confirmed");
    ck("DB2. A stale payment (expected unpaid, actually paid) is refused (f15:item_changed); a paid month refuses a second payment (f15:already_paid)", rpcErr("finance_employment_item_change", { p_kind: "payment", p_item: { ...it }, p_expected: { paid_minor: 0 }, p_events: [{}] }) === "f15:item_changed" && rpcErr("finance_employment_item_change", { p_kind: "payment", p_item: { ...it }, p_expected: { paid_minor: it.paid_minor }, p_events: [{}] }) === "f15:already_paid");
    const n = T_("finance_employment_items").find((i) => i.employment_id === E1 && i.month === "2026-11");
    ck("DB3. Partial payment is refused by the database too (f15:partial_payment_not_supported)", rpcErr("finance_employment_item_change", { p_kind: "payment", p_item: { ...n, paid_minor: 100, paid_date: "2026-10-15", paid_at: "x", paid_by: MGR }, p_expected: { paid_minor: 0 }, p_events: [{}] }) === "f15:partial_payment_not_supported");
    const v1 = T_("finance_employment_versions").find((v) => v.employment_id === E1 && v.supersedes_version_id === null);
    ck("DB4. A forked employment version is refused (f15:already_versioned); a confirm citing the wrong version for its month is refused (f15:employment_changed); a wrong salary snapshot is refused", rpcErr("finance_employment_version_record", { p_version: { ...v1, version_id: "FEV-AAAAAAAAAAA9", supersedes_version_id: v1.version_id, effective_from_month: "2027-06" }, p_events: [{}] }) === "f15:already_versioned" && rpcErr("finance_employment_item_change", { p_kind: "confirm", p_item: { ...n, item_id: "FEI-AAAAAAAAAAA8", month: "2027-01", expected_payment_date: "2027-01-28" }, p_expected: null, p_events: [{}] }) === "f15:employment_changed" && rpcErr("finance_employment_item_change", { p_kind: "confirm", p_item: { ...n, item_id: "FEI-AAAAAAAAAAA7", month: "2026-09", expected_payment_date: "2026-09-28", salary_minor: 1, estimate_total_minor: 28501 }, p_expected: null, p_events: [{}] }) === "f15:snapshot_mismatch");
    fake.leakTable = "finance_overhead_categories";
    const leak = await cats();
    fake.leakTable = null;
    ck("DB0. A store read returning another organisation's row is refused (503, nothing shown)", leak.httpStatus === 503 && (await cats()).httpStatus === 200);
    const asg = T_("finance_overhead_assignments")[0];
    ck("DB5. An assignment for a direct agreement, a second one for a version, or with a stale category name is refused by the database", rpcErr("finance_overhead_assign", { p_assignment: { ...asg, assignment_id: "FOA-AAAAAAAAAAA9", agreement_id: D1 }, p_events: [{}] }) === "f15:not_an_overhead" && rpcErr("finance_overhead_assign", { p_assignment: { ...asg, assignment_id: "FOA-AAAAAAAAAAA8" }, p_events: [{}] }) === "f15:already_categorised" && rpcErr("finance_overhead_assign", { p_assignment: { ...asg, assignment_id: "FOA-AAAAAAAAAAA7", agreement_id: U1, category_name_at_assignment: "Old name" }, p_events: [{}] }).startsWith("f15:"));
    ck("DB6. Pure lifecycle reuse: a month line maps onto F13's instalment shape, so stateOf / remainingOf / planChange decide Estimated -> Confirmed -> Paid; monthly salary is annual / 12 half away from zero; pay day clamps to month end", stateOf(asInstalment(ORG, monthLine(T_("finance_employment_versions").filter((v) => v.employment_id === E1).map((v) => ({ organisationId: v.organisation_id, versionId: v.version_id, employmentId: v.employment_id, supersedesVersionId: v.supersedes_version_id, personRef: v.person_ref, personName: v.person_name, categoryId: v.category_id, annualSalaryMinor: v.annual_salary_minor, payDay: v.pay_day, startDate: v.start_date, endDate: v.end_date, effectiveFromMonth: v.effective_from_month, pensionEstimateMinor: v.pension_estimate_minor, niPayeEstimateMinor: v.ni_paye_estimate_minor, notes: null, reason: null, createdAt: "", createdBy: "" })), [], "2027-02") as any)) === "estimated" && monthlySalaryOf(100) === 8 && monthlySalaryOf(1_000_006) === 83334 && payDateOf("2027-02", 31) === "2027-02-28" && payDateOf("2028-02", 30) === "2028-02-29" && planItemPayment(ORG, null, { action: "payment", amountMinor: 1, paidDate: "2026-10-01", method: null, reference: null, note: null }, { actor: MGR, at: "", today: "2026-10-15" }).ok === false);
  }

  // ===== AC. Access =====
  {
    const reads = [await cats({}, viewer), await cat(SOFT, viewer), await overheads({}, viewer), await overhead(S1, viewer), await emps({}, viewer), await emp(E1, {}, viewer), await facts({}, viewer)];
    ck("AC28. Finance View reads categories, overheads, one overhead, employment costs, one employment cost and facts (all 200, access view)", reads.every((r) => r.httpStatus === 200 && r.body.access === "view"));
    const snap = snapshot();
    const w = [await catNew({ name: "Vehicles" }, viewer), await catEdit(SOFT, { name: "X" }, viewer), await categorise({ agreementId: U1, categoryId: SOFT }, viewer), await overheadVersion(S3, { name: "x", costType: "one_off", classification: "general", effectiveFrom: "2027-05-01", amount: "1.00", firstDueDate: "2027-05-01", reason: "x" }, viewer), await empNew({ name: "V", categoryId: SAL, annualSalary: "1.00", payDay: 1, startDate: "2026-09-01" }, viewer), await empVersion(E1, { effectiveFromMonth: "2027-05", payDay: 2, reason: "x" }, viewer), await monthAct(E1, "2026-12", "confirm-estimate", { useEstimate: true }, viewer), await monthAct(E1, "2026-11", "payment", { amount: "2650.00", paidDate: "2026-10-15" }, viewer)];
    ck("AC29. Finance View cannot write (every write 403 finance_manage_required, nothing changed); Finance Manage made every write above", w.every((r) => r.httpStatus === 403 && r.code === "finance_manage_required") && snapshot() === snap);
    ck("AC30. No grant: reads and writes 403 finance_access_denied", (await cats({}, nogrant)).code === "finance_access_denied" && (await catNew({ name: "Vehicles" }, nogrant)).code === "finance_access_denied" && (await facts({}, nogrant)).code === "finance_access_denied");
    const cp = [await cats({}, coach), await emp(E1, {}, parent), await catNew({ name: "Vehicles" }, coach), await monthAct(E1, "2026-12", "confirm-estimate", { useEstimate: true }, parent)];
    ck("AC31. Coach and Parent denied (403 management_required)", cp.every((x) => x.httpStatus === 403 && x.code === "management_required"));
    world.moduleOn = false;
    const m1 = await overheads();
    const m2 = await empNew({ name: "M", categoryId: SAL, annualSalary: "1.00", payDay: 1, startDate: "2026-09-01" });
    world.moduleOn = true;
    ck("AC32. module_finance off: reads and writes 403 finance_module_disabled", m1.code === "finance_module_disabled" && m2.code === "finance_module_disabled");
    const t1 = parseOverheadQuery("overheads.list", new URLSearchParams("organisationId=ORG-OTHER-002"), isTenantKey) as any;
    const t2 = parseCategory(JSON.stringify({ name: "X", organisation_id: "ORG-OTHER-002" }), isTenantKey, true) as any;
    const t3 = parseEmploymentVersion(JSON.stringify({ effectiveFromMonth: "2027-05", payDay: 2, reason: "x", organisationId: "ORG-OTHER-002" }), isTenantKey) as any;
    const t4 = await categorise({ agreementId: U1, categoryId: SOFT, orgId: "ORG-OTHER-002" });
    const t5 = parseOverheadQuery("write", new URLSearchParams("month=2026-10"), isTenantKey) as any;
    ck("AC33. Tenant override rejected in query and bodies (400 tenant_param_rejected); writes take no query parameters", [t1, t2, t3, t4].every((t) => t.code === "tenant_param_rejected") && t5.code === "unexpected_parameter");
  }

  // ===== AU. Audit =====
  {
    const all = world.audit.filter((e) => e.context?.contract === "finance-overheads-v1");
    ck("AU34. Successful writes audited exactly: category create / update, categorise, overhead version, employment create / version, estimate confirmed, payment recorded - actor, route, before / after, F15 contract; no secrets", all.length > 0 && all.every((e) => e.actor_user_id === MGR && e.organisation_id === ORG && /^POST \//.test(e.context.route) && "after" in e) && [OVERHEAD_EVENTS.categoryCreated, OVERHEAD_EVENTS.categoryUpdated, OVERHEAD_EVENTS.categorised, OVERHEAD_EVENTS.versioned, OVERHEAD_EVENTS.employmentCreated, OVERHEAD_EVENTS.employmentVersioned, OVERHEAD_EVENTS.itemConfirmed, OVERHEAD_EVENTS.itemPaid].every((t) => all.some((e) => e.event_type === t)) && !/service-role|pat-test|sk_|rk_/.test(JSON.stringify(world.audit)) && softEv[0].record_id === `${ORG}:${SOFT}` && paidEv[0].record_id === `${ORG}:${E1}:2026-10` && deact.status === "ok" && world.audit.some((e) => e.event_type === OVERHEAD_EVENTS.categoryUpdated && e.after.changed.includes("active") && e.before.active === true && e.after.active === false));
    const n = world.audit.length;
    const rpc = world.rpcCalls;
    await cats();
    await cat(SOFT);
    await overheads();
    await overhead(S1);
    await emps();
    await emp(E1);
    await facts();
    await catNew({ name: "Software" });
    await categorise({ agreementId: S1, categoryId: SOFT });
    await monthAct(E1, "2026-10", "payment", { amount: "2785.00", paidDate: "2026-10-14" });
    await cats({}, nogrant);
    ck("AU35. Reads and refused writes are not audited (no audit row, no database write call)", world.audit.length === n && world.rpcCalls === rpc);
  }

  // ===== Z. Code / drift checks =====
  {
    const code = (f: string) => readFileSync(join(CANON, f), "utf8");
    const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const noStrings = (s: string) => s.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/`(?:[^`\\]|\\.)*`/g, "``");
    const pure = noComments(code("finance-overheads.ts"));
    const orch = noComments(code("finance-overheads-orchestrator.ts"));
    const repo = noComments(code("finance-overheads-repository.ts"));
    ck("Z1. finance-overheads.ts is pure (no fetch / Deno / Supabase / Airtable)", !/fetch\(|Deno\.|createClient|api\.airtable\.com/.test(pure));
    ck("Z2. F15 reads authorise View and writes Manage through F13's readCtx / withLock (F1 authorizeFinance + the shared commercial:{org} write lock); no fetch in the orchestrator", /readCtx\(deps, caller\)/.test(orch) && /withLock\(deps, caller,/.test(orch) && !/fetch\(/.test(orch) && !/authorizeFinance|acquireWriteLock/.test(orch));
    ck("Z3. F15 writes ONLY through its five database functions (one POST helper; no PATCH / DELETE / PUT); Airtable is read only (Coaches)", !/method: "(PATCH|DELETE|PUT)"/.test(repo) && (repo.match(/method: "POST"/g) ?? []).length === 1 && ["OVERHEAD_RPC.category", "OVERHEAD_RPC.assign", "OVERHEAD_RPC.version", "OVERHEAD_RPC.employment", "OVERHEAD_RPC.item"].every((r) => repo.includes(`${r},`)) && /tableUrl\(config, "Coaches"\)/.test(repo) && (repo.match(/tableUrl\(/g) ?? []).length === 1);
    const idx = code("index.ts");
    ck("Z4. index.ts routes F15 after F14 and before F12; the F15 routes exist; no overhead payment / confirm route (F13 owns those), no contractor, payroll, timesheet, Cash Flow or Month Report route", idx.indexOf("matchOverheadRoute(route") > idx.indexOf("matchCreditRoute(route") && idx.indexOf("matchOverheadRoute(route") < idx.indexOf("matchCoachCostRoute(route") && ["overhead-categories", "overheads", "employment-costs"].every((p) => matchOverheadRoute(p, "GET")?.status === "match" && matchOverheadRoute(p, "POST")?.status === "match") && matchOverheadRoute("overhead-facts", "GET")?.status === "match" && ITEM_ACTIONS.every((a) => matchOverheadRoute(`employment-costs/${E1}/months/2026-10/${a}`, "POST")?.status === "match") && [`overheads/${S1}/confirm-estimate`, `overheads/${S1}/payment`, `employment-costs/${E1}/payroll`, `employment-costs/${E1}/payslips`, `employment-costs/${E1}/months/2026-10/split`].every((p) => matchOverheadRoute(p, "POST")?.status === "not_found") && ["contractors", "payroll", "cash-flow", "month-report"].every((p) => matchOverheadRoute(p, "GET") === null) && matchOverheadRoute(`overhead-categories/${SOFT}`, "DELETE")?.status === "method");
    const copy = (f: string, swaps: [string, string][] = []) => {
      let c = code(f);
      for (const [a, b] of swaps) c = c.replace(a, b);
      return readFileSync(join(HERE, f), "utf8").endsWith(c);
    };
    ck("Z5. Test copies match the canonical files (import paths only)", copy("finance-overheads.ts") && copy("finance-overheads-orchestrator.ts") && copy("finance-overheads-repository.ts", [['"./repository.ts"', '"./finance-repository.ts"']]) && copy("finance-suppliers-orchestrator.ts", [['"./orchestrator.ts"', '"./finance-orchestrator.ts"']]));
    const f15 = noStrings(pure + orch + repo);
    ck("Z6. Not payroll, no Cash Flow / Month Report / bank: no payslip, tax-code, PAYE or NI calculation, payroll run, bank feed, Cash Flow or Month Report code; NI / PAYE only as Management-entered fields", !/cash ?flow|cashflow|month ?report|payslip|tax_?code|hmrc|reconcil|bank_feed|payroll_?run|niRate|niThreshold|personalAllowance/i.test(f15) && !/sk_live_[A-Za-z0-9]|rk_live_[A-Za-z0-9]/.test(f15));
    ck("Z7. Salary is never allocated to sessions / programmes: F15 never touches Coach Allocations, Session Occurrences, allocateDirectCost or a Finance Service split", !/Coach Allocations|Session Occurrences|allocateDirectCost|spreadEvenly|byFinanceService|financeServiceId/.test(f15));
    const imports = [...idx.matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}\s+from/gm)].flatMap((mm) => mm[1].split(",").map((s) => s.trim()).filter(Boolean).map((s) => (s.includes(" as ") ? s.split(" as ")[1] : s.replace(/^type\s+/, "")).trim()));
    const dupes = imports.filter((n, k) => imports.indexOf(n) !== k);
    ck("Z8. index.ts imports every name once (regression: F14 imported parseCreditCreate a second time, silently replacing F7's client-credit parser in the bundle)", dupes.length === 0 && /parseCreditCreate as parseSupplierCreditCreate/.test(idx) && /credit_note\.client_credit[\s\S]{0,200}parseCreditCreate\(raw/.test(idx));
    ck("Z9. One lifecycle: F15 uses F13's planChange / stateOf / remainingOf for Estimated -> Confirmed -> Paid and computes no remaining balance itself", /planChange\(/.test(pure) && /stateOf\(/.test(pure + orch) && !/amountDueMinor -/.test(f15) && /from "\.\/finance-suppliers\.ts"/.test(code("finance-overheads.ts")));
    const shared = ["finance-billing-mapping.ts", "finance-billing.ts", "finance-commercial-mapping.ts", "finance-commercial.ts", "finance-effective-dating.ts", "finance-invoicing-mapping.ts", "finance-invoicing.ts", "finance-issue-mapping.ts", "finance-issue.ts", "finance-lifecycle.ts", "finance-money.ts", "finance-settings.ts"];
    ck("Z10. No F15 code in the 12 Finance modules shared with Needs Attention; nothing seeded (no category is written by a read)", shared.every((f) => !/overhead|employment_cost|employment-cost/i.test(code(f))) && !/SUGGESTED_CATEGORIES[\s\S]{0,80}writeCategory/.test(orch));
  }

  for (const [s, n, e] of R) console.log(`${s}  ${n}${s === "FAIL" && e ? `  (${e})` : ""}`);
  console.log(`\n${R.length - failed}/${R.length} checks passed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
