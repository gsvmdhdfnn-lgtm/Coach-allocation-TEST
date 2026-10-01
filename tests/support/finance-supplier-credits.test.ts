/**
 * Finance Foundation F14 - supplier / venue credits.
 * Run: node --experimental-strip-types tests/support/finance-supplier-credits.test.ts
 *
 *   CC  credit creation (create, ownership, original amount, derived remaining, void unused)   brief 1-5
 *   AP  application (full, partial, remainder, instalment reduced, cross-supplier, over-credit,
 *       over-instalment, Paid, Cancelled; Estimated; duplicate retry)                         brief 6-14
 *   UN  unapply (before Paid, both balances restored, history kept, refused after Paid)        brief 15-19
 *   MC  multiple credits (separate, never automatic)                                           brief 20-21
 *   PY  payments (cash + credit math, no overpayment after credit, concurrency)                brief 22-24
 *   VC  venue cost (net real cost, gross visible, adjustment separate, history not rewritten) brief 25-28
 *   AC  access (View, Manage, no grant, coach / parent, module off, tenant)                    brief 29-34
 *   AU  audit (writes exact, reads / refusals none)                                            brief 35-36
 *   DB  database backstops (stale state, settled freeze, guard triggers)
 *   Z   code / drift checks against the canonical files
 *
 * The REAL F13 + F14 orchestrators and repository run against the shared
 * in-memory world (finance-suppliers-world.ts), whose fake database functions
 * follow the same rules as the TEST SQL (finance_f14_supplier_credits).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isTenantKey } from "./finance-access.ts";
import { remainingOf } from "./finance-suppliers.ts";
import { listCostFacts, readAgreement, readInstalment, readSupplier } from "./finance-suppliers-orchestrator.ts";
import { CREDIT_EVENTS, adjustmentRows, creditRemainingOf, creditStatusOf, matchCreditRoute, parseCreditAction, parseCreditCreate, parseCreditQuery, planApply, sessionsAttribution } from "./finance-supplier-credits.ts";
import { listCredits } from "./finance-supplier-credits-orchestrator.ts";
import { MGR, NOW, ORG, R, T_, VENUE_BODY, act, agreementNew, agreementVersion, ck, coach, credit, creditDo, creditNew, dbApps, dbCredit, dbInst, deps, evTypes, failed, mgr, nogrant, parent, pay, reset, rid, rpcFn, snapshot, supplierNew, updateInstalment, viewer, world } from "./finance-suppliers-world.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CANON = join(HERE, "..", "..", "supabase", "functions-test", "finance");

const cb = (supplierId: string, x: Record<string, unknown> = {}) => ({ supplierId, scope: "supplier", amount: "300.00", creditDate: "2026-10-10", sourceType: "credit_note", sourceReference: "ZZ-CN-001", reason: "ZZTEST hall leak refund", ...x });
const apply = (k: string, instalmentId: string, amount: string, caller: any = mgr, reason?: string) => creditDo(k, "apply", { instalmentId, amount, ...(reason ? { reason } : {}) }, caller);
const unapply = (k: string, applicationId: string, reason = "ZZTEST applied to the wrong month", caller: any = mgr) => creditDo(k, "unapply", { applicationId, reason }, caller);
const voidC = (k: string, reason = "ZZTEST entered in error", caller: any = mgr) => creditDo(k, "void", { reason }, caller);
const inst = async (id: string) => ((await readInstalment(deps, mgr, id)) as any).body;
const sup = async (id: string) => ((await readSupplier(deps, mgr, id)) as any).body;
const facts = async () => ((await listCostFacts(deps, mgr, { ok: true, fromMonth: "2026-10", toMonth: "2026-12" })) as any).body;
const minor = (s: string) => Math.round(Number(s) * 100);

async function main() {
  reset();
  // ----- fixtures: a venue (VEN) with a direct venue agreement (V1: 2 x 500.00 on ZZ-VENUE-A sessions)
  // and a general monthly agreement (G1: 3 x 300.00), an estimate; another supplier (OTH) -----
  const VEN = (await supplierNew({ name: "ZZTEST Venue Hall", type: "venue" })).body.supplier.supplierId as string;
  const OTH = (await supplierNew({ name: "ZZTEST Coach Bus Ltd", type: "contractor" })).body.supplier.supplierId as string;
  const v1 = await agreementNew(VENUE_BODY(VEN));
  const V1 = v1.body.agreement.agreementId as string;
  const [I1, I2] = v1.body.schedule.map((i: any) => i.instalmentId as string);
  const g1 = await agreementNew({ supplierId: VEN, name: "ZZTEST Hall storage", costType: "fixed", frequency: "monthly", classification: "general", effectiveFrom: "2026-10-01", amount: "300.00", firstDueDate: "2026-10-31", instalmentCount: 3 });
  const G1 = g1.body.agreement.agreementId as string;
  const G = g1.body.schedule.map((i: any) => i.instalmentId as string);
  const est = await agreementNew({ supplierId: VEN, name: "ZZTEST Hall extras", costType: "custom_dates", classification: "general", effectiveFrom: "2026-10-01", instalments: [{ dueDate: "2026-12-15", amount: "100.00", estimated: true }] });
  const E1 = est.body.schedule[0].instalmentId as string;
  const o1 = await agreementNew({ supplierId: OTH, name: "ZZTEST minibus", costType: "one_off", classification: "general", effectiveFrom: "2026-10-01", amount: "200.00", firstDueDate: "2026-11-01" });
  const OI = o1.body.schedule[0].instalmentId as string;
  ck("FX. Fixtures: 2 suppliers, venue agreement (2 x 500.00), monthly general (3 x 300.00), an estimate, another supplier's instalment", v1.httpStatus === 201 && g1.httpStatus === 201 && est.httpStatus === 201 && o1.httpStatus === 201 && G.length === 3 && dbInst(I1).amount_due_minor === 50000);
  const v1Before = (await readAgreement(deps, mgr, V1)) as any;
  const allocBefore = JSON.stringify(T_("finance_supplier_allocations").filter((x) => x.agreement_id === V1));
  const agreementRowBefore = JSON.stringify(T_("finance_supplier_agreements").find((x) => x.agreement_id === V1));
  const factsBefore = await facts();

  // ===== CC. Credit creation =====
  const a0 = world.audit.length;
  const c1 = await creditNew(cb(VEN));
  const K1 = c1.body?.credit?.creditId as string;
  ck("CC1. Create supplier credit: 201, FSC id, Available, amount 300.00, applied 0.00, remaining 300.00, source + reason kept, kind supplier_credit (not a payment / income / discount)", c1.httpStatus === 201 && /^FSC-[0-9A-F]{12}$/.test(K1) && c1.body.credit.status === "available" && c1.body.credit.statusLabel === "Available" && c1.body.credit.amount === "300.00" && c1.body.credit.applied === "0.00" && c1.body.credit.remaining === "300.00" && c1.body.credit.source.type === "credit_note" && c1.body.credit.source.reference === "ZZ-CN-001" && c1.body.credit.reason === "ZZTEST hall leak refund" && c1.body.credit.kind === "supplier_credit" && c1.body.credit.currency === "GBP", JSON.stringify(c1));
  ck("CC1b. ...recorded only: no application, no instalment touched, one finance_supplier_credit.created audit row", T_("finance_supplier_credit_applications").length === 0 && T_("finance_supplier_instalments").every((i) => i.credited_minor === 0) && evTypes(a0).join() === CREDIT_EVENTS.created && /nothing was applied/i.test(c1.body.note));
  const a1 = world.audit.length;
  const snap1 = snapshot();
  const bad = [
    await creditNew(cb(VEN, { reason: "" })),
    await creditNew(cb(VEN, { sourceReference: undefined })),
    await creditNew(cb(VEN, { creditDate: "2026-10-16" })),
    await creditNew(cb(VEN, { amount: "0.00" })),
    await creditNew(cb(VEN, { scope: "sessions", agreementId: V1 })),
    await creditNew(cb(VEN, { agreementId: G1 })),
    await creditNew(cb(VEN, { scope: "discount" })),
  ];
  ck("CC1c. Validation: reason and source reference required, no future credit date, positive amount, sessions need occurrences, supplier-only takes no agreement, scope is one of 3 (all 400, nothing saved)", bad.every((r) => r.httpStatus === 400) && bad[0].fields?.reason && bad[1].fields?.sourceReference && /future/.test(bad[2].error) && bad[4].fields?.occurrenceIds && bad[5].fields?.agreementId && bad[6].fields?.scope && snapshot() === snap1, JSON.stringify(bad.map((b) => [b.code, b.error, b.fields])));
  const rpc1 = world.rpcCalls;
  const dup = await creditNew(cb(VEN, { sourceReference: "zz-cn-001", amount: "10.00" }));
  const noSup = await creditNew(cb("FSU-FFFFFFFFFFFF"));
  const otherAgr = await creditNew(cb(OTH, { scope: "agreement", agreementId: V1, sourceReference: "ZZ-OTH-1" }));
  const genSess = await creditNew(cb(VEN, { scope: "sessions", agreementId: G1, occurrenceIds: [rid("OccA0")], sourceReference: "ZZ-X1" }));
  const notIn = await creditNew(cb(VEN, { scope: "sessions", agreementId: V1, occurrenceIds: [rid("OccB0")], sourceReference: "ZZ-X2" }));
  ck("CC1d. Refusals: same supplier + source + reference again is 409 duplicate_credit (a retry never records it twice); unknown supplier 404; another supplier's agreement 409; sessions on a general agreement / a session outside the agreement 409", dup.code === "duplicate_credit" && noSup.code === "supplier_not_found" && otherAgr.code === "agreement_not_for_supplier" && genSess.code === "agreement_has_no_sessions" && notIn.code === "session_not_in_agreement" && snapshot() === snap1 && world.audit.length === a1 && world.rpcCalls === rpc1);
  const venRead = await sup(VEN);
  const othRead = await sup(OTH);
  ck("CC2. Credits sit on the supplier: K1 belongs to the venue; the venue's read lists it, the other supplier's does not", dbCredit(K1).supplier_id === VEN && c1.body.credit.supplierId === VEN && venRead.credits.map((c: any) => c.creditId).join() === K1 && othRead.credits.length === 0 && venRead.whatWeArePaying.availableCredit === "300.00" && othRead.whatWeArePaying.availableCredit === "0.00");
  ck("CC4. Remaining is DERIVED (credit - active applications): the stored credit row has no balance column", !Object.keys(dbCredit(K1)).some((k) => /remain|balance|applied/.test(k)) && creditRemainingOf({ ...(c1.body.credit as any), amountMinor: 30000, creditId: K1, voidedAt: null } as any, []) === 30000);

  // ===== AP. Application =====
  const a2 = world.audit.length;
  const p1 = await apply(K1, I1, "200.00", mgr, "ZZTEST October hall invoice");
  const X1 = p1.body?.application?.applicationId as string;
  ck("AP7. Partial application (brief example): credit 300.00, instalment 500.00, apply 200.00 -> instalment remaining 300.00, credit remaining 100.00", p1.httpStatus === 201 && /^FSX-[0-9A-F]{12}$/.test(X1) && p1.body.instalment.remaining === "300.00" && p1.body.credit.remaining === "100.00" && p1.body.credit.applied === "200.00" && dbInst(I1).credited_minor === 20000 && dbInst(I1).paid_minor === 0, JSON.stringify(p1));
  ck("AP7b. ...never a payment: no payment row, cash paid stays 0.00; note says no cash moved; one finance_supplier_credit.applied audit row", T_("finance_supplier_payments").length === 0 && p1.body.instalment.paid === "0.00" && /No cash moved/.test(p1.body.note) && evTypes(a2).join() === CREDIT_EVENTS.applied);
  ck("AP8. Unused credit balance preserved: K1 Partially Applied with 100.00 still available", p1.body.credit.status === "partially_applied" && p1.body.credit.statusLabel === "Partially Applied" && (await credit(K1)).body.credit.remaining === "100.00");
  ck("CC3. Original amount preserved after application: still 300.00 (row amount_minor 30000 unchanged)", (await credit(K1)).body.credit.amount === "300.00" && dbCredit(K1).amount_minor === 30000);
  const i1v = await inst(I1);
  ck("AP9. Instalment read: amount due 500.00, cash paid 0.00, credit applied 200.00, remaining 300.00; settlement method credit (not cash), 'Partially Credited'; its application listed", i1v.instalment.amountDue === "500.00" && i1v.instalment.paid === "0.00" && i1v.instalment.creditApplied === "200.00" && i1v.instalment.remaining === "300.00" && i1v.instalment.settlement.method === "credit" && i1v.instalment.settlement.settled === false && i1v.instalment.stateLabel === "Partially Credited" && i1v.creditApplications.length === 1 && i1v.creditApplications[0].amount === "200.00", JSON.stringify(i1v.instalment));
  const p2 = await apply(K1, I2, "100.00");
  ck("AP8b. The remaining 100.00 applied elsewhere with the same supplier (another agreement's instalment is fine too): K1 Fully Applied, remaining 0.00", p2.httpStatus === 201 && p2.body.credit.status === "fully_applied" && p2.body.credit.remaining === "0.00" && dbInst(I2).credited_minor === 10000);
  const c2 = await creditNew(cb(VEN, { scope: "agreement", agreementId: G1, amount: "100.00", sourceReference: "ZZ-CN-002", reason: "ZZTEST storage unit unavailable a week" }));
  const K2 = c2.body.credit.creditId as string;
  const full = await apply(K2, G[0], "100.00");
  ck("AP6. Apply a full credit: 100.00 onto a 300.00 instalment -> credit Fully Applied (0.00 left), instalment remaining 200.00", c2.httpStatus === 201 && full.httpStatus === 201 && full.body.credit.status === "fully_applied" && full.body.credit.remaining === "0.00" && full.body.instalment.remaining === "200.00");
  const c5 = await creditNew(cb(VEN, { amount: "1000.00", sourceReference: "ZZ-CN-005", sourceType: "compensation", reason: "ZZTEST agreed compensation for closure" }));
  const K5 = c5.body.credit.creditId as string;
  const a3 = world.audit.length;
  const snap3 = snapshot();
  const rpc3 = world.rpcCalls;
  const overC = await apply(K2, G[1], "0.01");
  ck("AP11. Over-credit refused: K2 has 0.00 left -> 409 over_credit", overC.code === "over_credit");
  const overI = await apply(K5, I1, "300.01");
  ck("AP12. Over-applying to an instalment refused: 300.01 onto 300.00 remaining -> 409 over_instalment (no negative remaining)", overI.code === "over_instalment");
  const cross = await apply(K5, OI, "10.00");
  ck("AP10. Cross-supplier application refused: the venue's credit onto the other supplier's instalment -> 409 wrong_supplier", cross.code === "wrong_supplier");
  const estR = await apply(K5, E1, "10.00");
  ck("AP14b. Estimated instalment refused (confirm the amount first) -> 409 instalment_estimated", estR.code === "instalment_estimated");
  ck("AP10b. ...all those refusals were made by the API before any database call, changed nothing and wrote no audit (the database re-checks them too - DB / PY24c)", snapshot() === snap3 && world.audit.length === a3 && world.rpcCalls === rpc3);
  await pay(G[1], "300.00");
  await act(G[2], "cancel", { reason: "ZZTEST storage ended early" });
  const a4 = world.audit.length;
  const snap4 = snapshot();
  const paidR = await apply(K5, G[1], "10.00");
  const cancR = await apply(K5, G[2], "10.00");
  ck("AP13. Apply to a Paid instalment refused -> 409 instalment_settled", paidR.code === "instalment_settled");
  ck("AP14. Apply to a Cancelled instalment refused -> 409 instalment_cancelled", cancR.code === "instalment_cancelled" && snapshot() === snap4 && world.audit.length === a4);
  const r1 = await apply(K5, G[0], "50.00");
  const rpcR = world.rpcCalls;
  const r2 = await apply(K5, G[0], "50.00");
  ck("AP12b. No duplicate from a retry: the same credit onto the same instalment again is 409 already_applied_to_instalment (one active application per pair)", r1.httpStatus === 201 && r2.code === "already_applied_to_instalment" && world.rpcCalls === rpcR && dbApps(K5).filter((x) => x.instalment_id === G[0] && x.unapplied_at === null).length === 1 && dbInst(G[0]).credited_minor === 15000);

  // ===== UN. Unapply =====
  const a5 = world.audit.length;
  const u1 = await unapply(K1, X1);
  ck("UN15. Unapply before Paid: 200, application kept but inactive with who / when / reason", u1.httpStatus === 200 && u1.body.application.active === false && u1.body.application.unapplied.by === MGR && u1.body.application.unapplied.reason === "ZZTEST applied to the wrong month" && u1.body.application.unapplied.at === NOW.toISOString());
  ck("UN16. Credit balance restored: K1 remaining 200.00 (100.00 still applied to I2), Partially Applied", u1.body.credit.remaining === "200.00" && u1.body.credit.status === "partially_applied");
  ck("UN17. Instalment balance restored: I1 remaining 500.00, credit applied 0.00, back to Confirmed", u1.body.instalment.remaining === "500.00" && u1.body.instalment.creditApplied === "0.00" && u1.body.instalment.state === "confirmed" && dbInst(I1).credited_minor === 0);
  const k1r = await credit(K1);
  const rpcA = world.rpcCalls;
  const again = await unapply(K1, X1);
  const noReason = await creditDo(K1, "unapply", { applicationId: X1 });
  ck("UN18. History preserved: the application row still exists (unapplied_at / by / reason set, amount unchanged); the credit read lists it; audit unapplied with before / after; a second unapply is 409 already_unapplied; reason required", dbApps(K1).length === 2 && dbApps(K1).find((x) => x.application_id === X1)?.unapplied_by === MGR && dbApps(K1).find((x) => x.application_id === X1)?.amount_minor === 20000 && k1r.body.credit.applications.length === 2 && k1r.body.credit.applications.some((x: any) => x.applicationId === X1 && !x.active) && evTypes(a5).join() === CREDIT_EVENTS.unapplied && world.audit.at(-1).before.instalment.creditApplied === "200.00" && world.audit.at(-1).after.instalment.creditApplied === "0.00" && again.code === "already_unapplied" && world.rpcCalls === rpcA && noReason.httpStatus === 400);
  const re = await apply(K1, I1, "200.00");
  const X1b = re.body.application.applicationId as string;
  await pay(I1, "300.00");
  const i1Row = JSON.stringify(dbInst(I1));
  const appRow = JSON.stringify(dbApps(K1));
  const a6 = world.audit.length;
  const rpcL = world.rpcCalls;
  const late = await unapply(K1, X1b);
  ck("UN19. Unapply after Paid refused: I1 settled by 300.00 cash + 200.00 credit -> 409 instalment_settled; instalment and application rows byte-identical, no audit", re.httpStatus === 201 && late.code === "instalment_settled" && world.rpcCalls === rpcL && JSON.stringify(dbInst(I1)) === i1Row && JSON.stringify(dbApps(K1)) === appRow && world.audit.length === a6);
  const i1p = await inst(I1);
  ck("UN19b. Paid history immutable + honest: state paid but labelled 'Settled (cash + credit)'; cashPaid 300.00 / creditApplied 200.00 / remaining 0.00; payment history is the ONE 300.00 cash payment (credit is not a payment)", i1p.instalment.state === "paid" && i1p.instalment.stateLabel === "Settled (cash + credit)" && i1p.instalment.settlement.method === "cash_and_credit" && i1p.instalment.settlement.settled === true && i1p.instalment.settlement.cashPaid === "300.00" && i1p.instalment.settlement.creditApplied === "200.00" && i1p.instalment.remaining === "0.00" && i1p.instalment.payments.length === 1 && i1p.instalment.payments[0].amount === "300.00");
  const moveSettled = await act(I1, "move", { dueDate: "2026-12-01", reason: "x" });
  const cancelSettled = await act(I1, "cancel", { reason: "x" });
  ck("UN19c. A settled instalment is frozen for every other action too (move / cancel -> 409 instalment_paid)", moveSettled.code === "instalment_paid" && cancelSettled.code === "instalment_paid" && JSON.stringify(dbInst(I1)) === i1Row);

  // ===== CC5. Void =====
  const cv = await creditNew(cb(VEN, { amount: "50.00", sourceReference: "ZZ-CN-VOID", reason: "ZZTEST typed twice" }));
  const KV = cv.body.credit.creditId as string;
  const a7 = world.audit.length;
  const v = await voidC(KV);
  ck("CC5. Void an unused credit: 200, Voided, remaining 0.00, cost adjustment 0.00, kept on record with who / when / reason; one finance_supplier_credit.voided audit", v.httpStatus === 200 && v.body.credit.status === "voided" && v.body.credit.remaining === "0.00" && v.body.credit.amount === "50.00" && v.body.credit.costAdjustment.amount === "0.00" && v.body.credit.voided.by === MGR && dbCredit(KV).void_reason === "ZZTEST entered in error" && evTypes(a7).join() === CREDIT_EVENTS.voided);
  const a8 = world.audit.length;
  const rpc8 = world.rpcCalls;
  const v2 = await voidC(KV);
  const rpc8b = world.rpcCalls;
  const usedVoid = await voidC(K1);
  const cu = await creditNew(cb(VEN, { amount: "20.00", sourceReference: "ZZ-CN-UNDO", reason: "ZZTEST" }));
  const KU = cu.body.credit.creditId as string;
  const ua = await apply(KU, I2, "20.00");
  await unapply(KU, ua.body.application.applicationId);
  const a9 = world.audit.length;
  const rpcV = world.rpcCalls;
  const unappliedVoid = await voidC(KU);
  const voidApply = await apply(KV, I2, "1.00");
  const rpcV2 = world.rpcCalls;
  const reuse = await creditNew(cb(VEN, { amount: "50.00", sourceReference: "ZZ-CN-VOID", reason: "ZZTEST re-entered correctly" }));
  ck("CC5b. Void refusals (all made by the API before the database): twice -> already_voided; a used credit -> credit_has_applications (even after every application was unapplied: only a NEVER-applied credit is voided); a voided credit cannot be applied; no deletes", v2.code === "already_voided" && rpc8b === rpc8 && usedVoid.code === "credit_has_applications" && unappliedVoid.code === "credit_has_applications" && voidApply.code === "credit_voided" && rpcV2 === rpcV && world.audit.length === a9 + 1 && a9 - a8 === 3 && !!dbCredit(KV) && !!dbCredit(K1));
  ck("CC5c. A voided credit's reference may be recorded again correctly (the duplicate guard covers live credits only)", reuse.httpStatus === 201);
  const KR = reuse.body.credit.creditId as string;

  // ===== MC. Multiple credits =====
  const list = (await listCredits(deps, mgr, { supplierId: VEN })) as any;
  const byId = new Map(list.body.credits.map((c: any) => [c.creditId, c]));
  ck("MC20. Multiple credits stay separate: each listed with its own amount / applied / remaining / status (K1 300/300/0 after the re-apply, K2 100/100/0, K5 1000/50/950, KU 20/0/20, KV voided)", list.httpStatus === 200 && list.body.credits.length === 6 && (byId.get(K1) as any)?.remaining === "0.00" && (byId.get(K1) as any)?.applied === "300.00" && (byId.get(KU) as any)?.remaining === "20.00" && (byId.get(KU) as any)?.status === "available" && (byId.get(K2) as any)?.status === "fully_applied" && (byId.get(K5) as any)?.remaining === "950.00" && (byId.get(KV) as any)?.status === "voided" && list.body.credits.every((c: any) => c.supplierId === VEN));
  const avail = (await listCredits(deps, mgr, { status: "available" })) as any;
  const venNow = await sup(VEN);
  ck("MC20b. Filters and totals: status=available lists only untouched live credits; the supplier read shows available credit = sum of remaining (K5 950 + KU 20 + KR 50 = 1020.00) and credit applied separately from cash paid", avail.body.credits.every((c: any) => c.status === "available") && avail.body.credits.some((c: any) => c.creditId === KR) && venNow.whatWeArePaying.availableCredit === "1020.00" && venNow.whatWeArePaying.creditApplied === "450.00" && venNow.whatWeArePaying.paidToDate === "600.00" && venNow.cost.cost.creditAdjustment === "1470.00" && venNow.cost.payable.creditApplied === "450.00", JSON.stringify([venNow.whatWeArePaying, venNow.cost]));
  const appsBefore = T_("finance_supplier_credit_applications").length;
  const ag2 = await agreementNew({ supplierId: VEN, name: "ZZTEST January hire", costType: "one_off", classification: "general", effectiveFrom: "2027-01-01", amount: "80.00", firstDueDate: "2027-01-10" });
  await pay(G[0], "10.00");
  ck("MC21. No automatic application: with 1020.00 of credit available, a new agreement's instalment starts uncredited and a payment consumes no credit (applications only ever come from an explicit Apply)", ag2.httpStatus === 201 && dbInst(ag2.body.schedule[0].instalmentId).credited_minor === 0 && T_("finance_supplier_credit_applications").length === appsBefore && dbInst(G[0]).credited_minor === 15000);

  // ===== PY. Payments =====
  // I2: 500.00 due, 100.00 credit (K1) applied
  const pp = await pay(I2, "150.00");
  const i2v = await inst(I2);
  ck("PY22. Cash + credit math: 500.00 due - 150.00 cash - 100.00 credit = 250.00 remaining; 'Partially Paid + Credited', method cash_and_credit; the payment's remainingAfter is 250.00", pp.httpStatus === 201 && i2v.instalment.remaining === "250.00" && i2v.instalment.paid === "150.00" && i2v.instalment.creditApplied === "100.00" && i2v.instalment.stateLabel === "Partially Paid + Credited" && i2v.instalment.settlement.method === "cash_and_credit" && pp.body.payment.remainingAfter === "250.00");
  const snapP = snapshot();
  const overpay = await pay(I2, "250.01");
  ck("PY23. A payment cannot exceed the remaining AFTER credit: 250.01 -> 409 overpayment (250.00 fits)", overpay.code === "overpayment" && snapshot() === snapP);
  const ev = [{ organisation_id: ORG, actor_user_id: MGR, event_type: "finance_supplier_instalment.paid", entity_type: "finance_supplier_instalment", record_id: `${ORG}:${I2}`, before: null, after: {}, reason: null, context: {} }];
  const i2 = dbInst(I2);
  const dbPay = (expected: Record<string, unknown>, amount: number) => {
    try {
      rpcFn("finance_supplier_instalment_change", { p_org: ORG, p_instalment_id: I2, p_kind: "payment", p_expected: expected, p_change: {}, p_new_instalments: [], p_payment: { organisation_id: ORG, payment_id: "FSP-EEEEEEEEEEEE", instalment_id: I2, agreement_id: V1, supplier_id: VEN, amount_minor: amount, paid_date: "2026-10-15", method: null, reference: null, note: null, remaining_after_minor: 25000 - amount, recorded_at: NOW.toISOString(), recorded_by: MGR }, p_events: ev });
      return "ok";
    } catch (e) {
      return String((e as Error).message).replace(/^f1[34]:/, "");
    }
  };
  const exp = { paid_minor: i2.paid_minor, credited_minor: i2.credited_minor, amount_due_minor: i2.amount_due_minor, due_date: i2.due_date, amount_state: i2.amount_state, cancelled: false };
  const dbOver = dbPay(exp, 25001);
  const { credited_minor: _drop, ...oldCaller } = exp;
  const dbOld = dbPay(oldCaller, 100);
  ck("PY23b. The database backstop uses the same rule: 250.01 -> f13:overpayment; a caller that does not know about the 100.00 credit (no credited_minor in its expected state) -> f13:instalment_changed; nothing written", dbOver === "overpayment" && dbOld === "instalment_changed" && snapshot() === snapP);
  const [x1, x2] = await Promise.all([apply(K5, I2, "200.00"), pay(I2, "200.00")]);
  const okN = [x1, x2].filter((x) => x.httpStatus === 201).length;
  const busyN = [x1, x2].filter((x) => x.code === "finance_commercial_busy").length;
  const i2r = dbInst(I2);
  ck("PY24. Payment vs credit at the same moment: exactly one succeeds, the other is 409 finance_commercial_busy (shared Finance write lock); remaining stays valid (50.00, never negative)", okN === 1 && busyN === 1 && i2r.amount_due_minor - i2r.paid_minor - i2r.credited_minor === 5000);
  const [y1, y2] = await Promise.all([apply(K5, G[0], "1.00"), apply(KR, G[0], "1.00")]);
  ck("PY24b. Two applications at the same moment: one succeeds, the other is busy - no overspend, no double application", [y1, y2].filter((x) => x.httpStatus === 201 || x.code === "already_applied_to_instalment").length + [y1, y2].filter((x) => x.code === "finance_commercial_busy").length === 2 && [y1, y2].filter((x) => x.code === "finance_commercial_busy").length === 1);
  const k5now = dbCredit(K5);
  const k5App = { organisation_id: ORG, application_id: "FSX-EEEEEEEEEEEE", credit_id: K5, instalment_id: I2, agreement_id: V1, supplier_id: VEN, amount_minor: 100, applied_at: NOW.toISOString(), applied_by: MGR, reason: null, unapplied_at: null, unapplied_by: null, unapply_reason: null };
  const dbApply = (expected: any) => {
    try {
      rpcFn("finance_supplier_credit_change", { p_org: ORG, p_credit_id: K5, p_kind: "apply", p_expected: expected, p_application: k5App, p_void: null, p_events: [{ ...ev[0], event_type: CREDIT_EVENTS.applied, entity_type: "finance_supplier_credit", record_id: `${ORG}:${K5}` }] });
      return "ok";
    } catch (e) {
      return String((e as Error).message).replace(/^f1[34]:/, "");
    }
  };
  const live = { instalment_id: I2, paid_minor: dbInst(I2).paid_minor, credited_minor: dbInst(I2).credited_minor, amount_due_minor: dbInst(I2).amount_due_minor };
  const appliedNow = dbApps(K5).filter((x) => x.unapplied_at === null).reduce((s, x) => s + x.amount_minor, 0);
  const snapD = snapshot();
  ck("PY24c. The database function re-checks under its own row locks: a stale credit balance -> f14:credit_changed; a stale instalment -> f13:instalment_changed; nothing written", dbApply({ applied_minor: appliedNow - 1, instalment: live }) === "credit_changed" && dbApply({ applied_minor: appliedNow, instalment: { ...live, credited_minor: live.credited_minor + 1 } }) === "instalment_changed" && snapshot() === snapD && !!k5now);

  // ===== VC. Venue cost =====
  const k3 = await creditNew(cb(VEN, { scope: "sessions", agreementId: V1, occurrenceIds: [rid("OccA1"), rid("OccA0")], amount: "90.01", creditDate: "2026-10-14", sourceReference: "ZZ-CN-SESS", reason: "ZZTEST hall flooded two sessions" }));
  const K3 = k3.body?.credit?.creditId as string;
  const k4 = await creditNew(cb(VEN, { scope: "agreement", agreementId: V1, amount: "60.00", creditDate: "2026-10-12", sourceReference: "ZZ-CN-AGR", sourceType: "refund_adjustment", reason: "ZZTEST term price reduced" }));
  const K4 = k4.body?.credit?.creditId as string;
  ck("VC25a. Specific-session credit: 90.01 spread exactly over the 2 chosen sessions in date order (45.01 + 45.00), each with its Finance Service; whole-agreement credit attributed to the agreement's single service FSV-AAAAAAAAAAAA", k3.httpStatus === 201 && k3.body.credit.costAdjustment.sessions.map((s: any) => `${s.date}:${s.adjustment}:${s.financeServiceId}`).join() === "2026-10-01:45.01:FSV-AAAAAAAAAAAA,2026-10-08:45.00:FSV-AAAAAAAAAAAA" && k4.httpStatus === 201 && k4.body.credit.costAdjustment.financeServiceId === "FSV-AAAAAAAAAAAA" && k4.body.credit.costAdjustment.scope === "agreement", JSON.stringify([k3.body?.credit?.costAdjustment, k4.body?.credit?.costAdjustment, k3.code, k3.error]));
  const k6 = await creditNew(cb(VEN, { scope: "agreement", agreementId: V1, amount: "5.00", creditDate: "2026-10-12", sourceReference: "ZZ-CN-V1-ERR", reason: "ZZTEST typed in error" }));
  await voidC(k6.body.credit.creditId);
  const v1After = (await readAgreement(deps, mgr, V1)) as any;
  const ca = v1After.body.creditAdjustments;
  const gross = v1Before.body.profitability.allocatedTotal as string;
  ck("VC25. Genuine venue credit reduces the net real cost: V1 gross " + gross + " - credit adjustment 150.01 = net, and per Finance Service (a voided 5.00 credit on V1 counts for nothing)", ca.gross === gross && ca.creditAdjustment === "150.01" && minor(ca.net) === minor(gross) - 15001 && ca.byFinanceService.length === 1 && ca.byFinanceService[0].financeServiceId === "FSV-AAAAAAAAAAAA" && ca.byFinanceService[0].creditAdjustment === "150.01" && minor(ca.byFinanceService[0].net) === minor(ca.byFinanceService[0].gross) - 15001 && ca.credits.length === 3 && ca.credits.filter((c: any) => c.status === "voided").length === 1, JSON.stringify(ca));
  ck("VC26. Original gross cost stays visible: the F13 profitability (allocated total, every per-session share, by-service totals) is exactly as before the credits", JSON.stringify(v1After.body.profitability) === JSON.stringify(v1Before.body.profitability));
  const fa = await facts();
  const adj = fa.creditAdjustments as any[];
  const a3r = adj.find((x) => x.creditId === K3);
  const a4r = adj.find((x) => x.creditId === K4);
  const a1r = adj.find((x) => x.creditId === K1);
  ck("VC27. Credit adjustment shown separately: its own fact rows (negative, dated when recorded) beside unchanged profitability rows; session attribution kept alongside; a supplier-only credit has no session attribution", JSON.stringify(fa.profitability) === JSON.stringify(factsBefore.profitability) && a3r?.amount === "-90.01" && a3r?.date === "2026-10-14" && a3r?.attribution.map((x: any) => `${x.sessionDate}:${x.amount}`).join() === "2026-10-01:-45.01,2026-10-08:-45.00" && a4r?.amount === "-60.00" && a4r?.attribution[0].financeServiceId === "FSV-AAAAAAAAAAAA" && a1r?.attribution.length === 0 && !adj.some((x) => x.creditId === KV), JSON.stringify(adj));
  const fsvNet = fa.byFinanceServiceNet.find((x: any) => x.financeServiceId === "FSV-AAAAAAAAAAAA");
  const fsvGross = factsBefore.byFinanceService.find((x: any) => x.financeServiceId === "FSV-AAAAAAAAAAAA");
  ck("VC27b. By Finance Service: gross (= F13 total, unchanged) - creditAdjustment 150.01 = net; F13's own byFinanceService block is unchanged", fsvNet.gross === fsvGross.total && fsvNet.creditAdjustment === "150.01" && minor(fsvNet.net) === minor(fsvGross.total) - 15001 && JSON.stringify(fa.byFinanceService) === JSON.stringify(factsBefore.byFinanceService));
  const venCost = fa.supplierCost.suppliers.find((x: any) => x.supplierId === VEN);
  const pay_ = venCost.payable;
  ck("VC27c. Supplier cost facts as separate figures: gross / creditAdjustment / net and amountDue / cashPaid / creditApplied / remainingPayable (cash + credit + remaining = due)", minor(venCost.cost.net) === minor(venCost.cost.gross) - minor(venCost.cost.creditAdjustment) && minor(pay_.cashPaid) + minor(pay_.creditApplied) + minor(pay_.remainingPayable) === minor(pay_.amountDue) && minor(venCost.cost.creditAdjustment) === T_("finance_supplier_credits").filter((c) => c.supplier_id === VEN && c.voided_at === null).reduce((x, c) => x + c.amount_minor, 0) && venCost.cost.creditAdjustment === "1620.01" && Array.isArray(fa.cashTiming.creditApplied) && fa.cashTiming.creditApplied.every((x: any) => x.cash === false), JSON.stringify(venCost));
  const netBefore = fa.supplierCost.total.cost.net;
  const k3Adj = (await credit(K3)).body.credit.costAdjustment.amount;
  const ap3 = await apply(K3, I2, "50.00");
  const fb = await facts();
  ck("VC28. Applying a credit changes only what is payable, never the cost again (one credit = one cost correction): net cost and K3's adjustment unchanged after applying it; remaining payable down 50.00", ap3.httpStatus === 201 && fb.supplierCost.total.cost.net === netBefore && (await credit(K3)).body.credit.costAdjustment.amount === k3Adj && minor(fb.supplierCost.total.payable.remainingPayable) === minor(fa.supplierCost.total.payable.remainingPayable) - 5000);
  ck("VC28b. Historical agreement not rewritten: V1's stored agreement row and frozen allocation rows are byte-identical", JSON.stringify(T_("finance_supplier_agreements").find((x) => x.agreement_id === V1)) === agreementRowBefore && JSON.stringify(T_("finance_supplier_allocations").filter((x) => x.agreement_id === V1)) === allocBefore);
  // Version / cancel refused while credit is applied (locked default)
  const snapV = snapshot();
  const ver = await agreementVersion(G1, { name: "ZZTEST storage v2", costType: "fixed", frequency: "monthly", classification: "general", effectiveFrom: "2026-10-30", amount: "250.00", firstDueDate: "2026-11-30", instalmentCount: 1, reason: "ZZTEST new price" });
  ck("VC28c. A version over an instalment with credit applied is refused until unapplied (paid one first: paid_instalment_after_change; credited one: credited_instalment_after_change)", ["paid_instalment_after_change", "credited_instalment_after_change"].includes(ver.code) && snapshot() === snapV, ver.code);
  const ag3 = await agreementNew({ supplierId: VEN, name: "ZZTEST spring hire", costType: "custom_dates", classification: "general", effectiveFrom: "2026-10-01", instalments: [{ dueDate: "2027-03-01", amount: "100.00" }, { dueDate: "2027-04-01", amount: "100.00" }] });
  const [S1, S2] = ag3.body.schedule.map((i: any) => i.instalmentId as string);
  await apply(KR, S2, "10.00");
  const snapV2 = snapshot();
  const rpcVer = world.rpcCalls;
  const ver2 = await agreementVersion(ag3.body.agreement.agreementId, { name: "ZZTEST spring v2", costType: "one_off", classification: "general", effectiveFrom: "2027-03-15", amount: "90.00", firstDueDate: "2027-04-01", reason: "ZZTEST" });
  const canc = await act(S2, "cancel", { reason: "ZZTEST" });
  ck("VC28d. ...with only a credited (unpaid) instalment after the start: version -> 409 credited_instalment_after_change; cancelling it -> 409 instalment_has_credit; both refused by the API before the database; nothing changed", ver2.code === "credited_instalment_after_change" && canc.code === "instalment_has_credit" && snapshot() === snapV2 && world.rpcCalls === rpcVer && !!S1);
  await apply(K5, S1, "10.00");
  const sp = await act(S1, "split", { parts: [{ dueDate: "2027-03-01", amount: "40.00" }, { dueDate: "2027-03-08", amount: "50.00" }], reason: "ZZTEST split the March hire" });
  const kid = sp.body?.newInstalments?.[0]?.instalmentId as string;
  ck("VC28e. Splitting a credited instalment splits only what is still owed: 100.00 due with 10.00 credit -> 50.00 due (10.00 credit + 40.00 owed) + a new 50.00 instalment carrying no credit", sp.httpStatus === 201 && sp.body.instalment.amountDue === "50.00" && sp.body.instalment.creditApplied === "10.00" && sp.body.instalment.remaining === "40.00" && dbInst(kid)?.amount_due_minor === 5000 && dbInst(kid)?.credited_minor === 0 && dbInst(S1).credited_minor === 1000, JSON.stringify(sp.body?.instalment ?? sp));

  // ===== AC. Access =====
  {
    const reads = [listCredits(deps, viewer, {}), credit(K1, viewer), readInstalment(deps, viewer, I1), readSupplier(deps, viewer, VEN), readAgreement(deps, viewer, V1), listCostFacts(deps, viewer, { ok: true })];
    const rs = (await Promise.all(reads)) as any[];
    ck("AC29. Finance View reads credits, one credit, and the credit-aware instalment / supplier / agreement / facts reads (all 200, access view)", rs.every((r) => r.httpStatus === 200 && r.body.access === "view"));
    const before = snapshot();
    const w = [await creditNew(cb(VEN, { sourceReference: "ZZ-V" }), viewer), await apply(K5, I2, "1.00", viewer), await unapply(K1, X1b, "x", viewer), await voidC(KR, "x", viewer)];
    ck("AC30. Finance View cannot create / apply / unapply / void (403 finance_manage_required, nothing changed); Finance Manage does all four (above)", w.every((r) => r.httpStatus === 403 && r.code === "finance_manage_required") && snapshot() === before);
    const n1 = (await listCredits(deps, nogrant, {})) as any;
    const n2 = await apply(K5, I2, "1.00", nogrant);
    ck("AC31. No grant: reads and writes 403 finance_access_denied", n1.code === "finance_access_denied" && n2.code === "finance_access_denied");
    const c1_ = (await credit(K1, coach)) as any;
    const c2_ = await creditNew(cb(VEN, { sourceReference: "ZZ-C" }), coach);
    const p1_ = (await listCredits(deps, parent, {})) as any;
    const p2_ = await voidC(KR, "x", parent);
    ck("AC32. Coach and Parent denied (403 management_required)", [c1_, c2_, p1_, p2_].every((x) => x.code === "management_required"));
    world.moduleOn = false;
    const m1 = (await listCredits(deps, mgr, {})) as any;
    const m2 = await apply(K5, I2, "1.00");
    world.moduleOn = true;
    ck("AC33. module_finance off: reads and writes 403 finance_module_disabled", m1.code === "finance_module_disabled" && m2.code === "finance_module_disabled");
    const t1 = parseCreditQuery("credits.list", new URLSearchParams("organisationId=ORG-X"), isTenantKey) as any;
    const t2 = parseCreditCreate(JSON.stringify({ ...cb(VEN), organisation_id: "ORG-X" }), isTenantKey) as any;
    const t3 = parseCreditAction("apply", JSON.stringify({ instalmentId: I2, amount: "1.00", org_id: "ORG-X" }), isTenantKey) as any;
    const t4 = parseCreditAction("void", JSON.stringify({ reason: "x", organisationId: "ORG-X" }), isTenantKey) as any;
    ck("AC34. Tenant override rejected in the query and every body (400 tenant_param_rejected)", [t1, t2, t3, t4].every((t) => t.code === "tenant_param_rejected"));
    const q1 = parseCreditQuery("credits.create", new URLSearchParams("supplierId=" + VEN), isTenantKey) as any;
    const q2 = parseCreditQuery("credits.list", new URLSearchParams("status=open"), isTenantKey) as any;
    const q3 = parseCreditAction("apply", JSON.stringify({ instalmentId: I2, amount: "1.00", auto: true }), isTenantKey) as any;
    const q4 = parseCreditAction("unapply", JSON.stringify({ applicationId: "FSX-1", reason: "x" }), isTenantKey) as any;
    ck("AC34b. Query / body validation: writes take no query parameters; unknown status / field refused; malformed application id refused", q1.code === "unexpected_parameter" && q2.code === "invalid_query" && q3.code === "unexpected_field" && q4.httpStatus === 400);
  }

  // ===== AU. Audit =====
  {
    const aR = world.audit.length;
    await listCredits(deps, mgr, {});
    await credit(K1);
    await readInstalment(deps, mgr, I1);
    await readSupplier(deps, mgr, VEN);
    ck("AU36. Reads write no audit", world.audit.length === aR);
    world.lockHeld = "someone-else";
    const busy = await apply(K5, I2, "1.00");
    world.lockHeld = null;
    ck("AU36b. Refused writes create no success audit (busy lock here; every refusal above was checked with an unchanged audit count / snapshot)", busy.code === "finance_commercial_busy" && world.audit.length === aR);
    const f14 = world.audit.filter((e) => e.entity_type === "finance_supplier_credit");
    const creditsN = T_("finance_supplier_credits").length;
    const appsN = T_("finance_supplier_credit_applications").length;
    const unappliedN = T_("finance_supplier_credit_applications").filter((x) => x.unapplied_at !== null).length;
    const voidedN = T_("finance_supplier_credits").filter((x) => x.voided_at !== null).length;
    const n = (t: string) => f14.filter((e) => e.event_type === t).length;
    ck("AU35. Exact audit: one created per stored credit, one applied per stored application, one unapplied per unapplied row, one voided per voided credit - and only these 4 event types", n(CREDIT_EVENTS.created) === creditsN && n(CREDIT_EVENTS.applied) === appsN && n(CREDIT_EVENTS.unapplied) === unappliedN && n(CREDIT_EVENTS.voided) === voidedN && f14.length === creditsN + appsN + unappliedN + voidedN, `${n(CREDIT_EVENTS.created)}/${creditsN} ${n(CREDIT_EVENTS.applied)}/${appsN} ${n(CREDIT_EVENTS.unapplied)}/${unappliedN} ${n(CREDIT_EVENTS.voided)}/${voidedN}`);
    ck("AU35b. Every credit audit row: actor, ORG:FSC record id, contract finance-supplier-credits-v1, route, before / after; no secrets", f14.every((e) => e.actor_user_id === MGR && e.organisation_id === ORG && new RegExp(`^${ORG}:FSC-[0-9A-F]{12}$`).test(e.record_id) && e.context.contract === "finance-supplier-credits-v1" && /^POST \/supplier-credits/.test(e.context.route) && e.after && !/service-role|pat-test|sk_live|rk_live/.test(JSON.stringify(e))));
    const lastApply = f14.filter((e) => e.event_type === CREDIT_EVENTS.applied).at(-1);
    ck("AU35c. The applied event carries the credit before / after and the instalment before / after (remaining, cash, credit)", lastApply.before.instalment && lastApply.after.instalment && lastApply.after.application && "creditApplied" in lastApply.after.instalment && "remaining" in lastApply.after.instalment);
  }

  // ===== DB. Database backstops =====
  {
    const guard = (patch: Record<string, unknown>, id = I2) => {
      try {
        updateInstalment(ORG, id, patch);
        return "ok";
      } catch (e) {
        return String((e as Error).message);
      }
    };
    const s = snapshot();
    const r1 = guard({ credited_minor: dbInst(I1).credited_minor - 1 }, I1);
    const r2 = guard({ credited_minor: dbInst(G[0]).credited_minor + 1, paid_minor: dbInst(G[0]).paid_minor + 1 }, G[0]);
    const r3 = guard({ credited_minor: dbInst(G[0]).amount_due_minor }, G[0]);
    const r4 = guard({ credited_minor: dbInst(I2).credited_minor - 1 });
    ck("DB1. Guard / CHECKs: a settled instalment's credit can never change; cash and credit never move in one update; paid + credited can never exceed the amount due", /history_is_append_only/.test(r1) && /history_is_append_only/.test(r4) && /history_is_append_only/.test(r2) && /check violation/.test(r3) && snapshot() === s, [r1, r2, r3, r4].join(" | "));
    const pa = planApply({ organisationId: ORG, creditId: K5, supplierId: VEN, voidedAt: null, amountMinor: 100000 } as any, [], { ...({} as any), instalmentId: I2, supplierId: VEN, cancelledAt: null, amountState: "confirmed", amountDueMinor: 100, paidMinor: 60, creditedMinor: 40 }, { instalmentId: I2, amountMinor: 1, reason: null }, { actor: MGR, at: NOW.toISOString(), applicationId: "FSX-AAAAAAAAAAAA" }) as any;
    ck("DB2. planApply on its own (before the database): an instalment settled by cash + credit is instalment_settled", pa.code === "instalment_settled");
    const rows = sessionsAttribution(ORG, K3, 100, [{ occurrenceRecordId: "b", occurrenceDate: "2026-10-02" }, { occurrenceRecordId: "a", occurrenceDate: "2026-10-01" }, { occurrenceRecordId: "c", occurrenceDate: "2026-10-03" }] as any, ["a", "b", "c"]);
    ck("DB3. sessionsAttribution is exact and deterministic (1.00 / 3 = 0.34 + 0.33 + 0.33, earliest first)", rows.map((r) => `${r.occurrenceRecordId}:${r.adjustmentMinor}`).join() === "a:34,b:33,c:33");
    const vRow = { creditId: "FSC-X", scope: "supplier", voidedAt: null, amountMinor: 5 } as any;
    ck("DB4. adjustmentRows: supplier-only and voided credits add no Finance Service adjustment; status of a voided credit is Voided whatever its applications", adjustmentRows(vRow, []).length === 0 && adjustmentRows({ ...vRow, scope: "agreement", voidedAt: "x" }, []).length === 0 && creditStatusOf({ ...vRow, voidedAt: "x" }, []) === "voided");
    ck("DB5. remainingOf is due - paid - credited (cancelled = 0)", remainingOf({ amountDueMinor: 100, paidMinor: 30, creditedMinor: 20, cancelledAt: null } as any) === 50 && remainingOf({ amountDueMinor: 100, paidMinor: 0, creditedMinor: 0, cancelledAt: "x" } as any) === 0);
  }

  // ===== Z. Code / drift checks =====
  {
    const code = (f: string) => readFileSync(join(CANON, f), "utf8");
    const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const noStrings = (s: string) => s.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/`(?:[^`\\]|\\.)*`/g, "``");
    const pure = noComments(code("finance-supplier-credits.ts"));
    const orch = noComments(code("finance-supplier-credits-orchestrator.ts"));
    const f13orch = noComments(code("finance-suppliers-orchestrator.ts"));
    const repo = noComments(code("finance-suppliers-repository.ts"));
    ck("Z1. finance-supplier-credits.ts is pure (no fetch / Deno / Supabase / Airtable)", !/fetch\(|Deno\.|createClient|api\.airtable\.com/.test(pure));
    ck("Z2. Credit reads authorise View and writes Manage through the F13 helpers (F1 authorizeFinance + the shared commercial:{org} write lock); no fetch", /readCtx\(deps, caller\)/.test(orch) && /withLock\(deps, caller,/.test(orch) && /authorizeFinance\(deps, caller, "read"\)/.test(f13orch) && /authorizeFinance\(deps, caller, "manage"\)/.test(f13orch) && /`commercial:\$\{o\.organisationId\}`/.test(f13orch) && !/fetch\(/.test(orch));
    ck("Z3. Credits are written ONLY through the two database functions (one POST helper; no PATCH / DELETE)", !/method: "(PATCH|DELETE|PUT)"/.test(repo) && (repo.match(/method: "POST"/g) ?? []).length === 1 && /RPC\.credit,/.test(repo) && /RPC\.creditChange,/.test(repo));
    ck("Z4. No auto-apply path: only creditAction (the explicit /apply route) ever calls changeCredit with an application; creating a credit never applies it; F13 code never records or applies credits", (orch.match(/changeCredit\(/g) ?? []).length === 2 && !/changeCredit|planApply/.test(f13orch) && !/changeCredit|planApply/.test(noComments(code("finance-suppliers.ts"))) && /export function createCredit[\s\S]*?recordCredit\([\s\S]*?\n\}/.test(orch) && !/export function createCredit[\s\S]*?changeCredit[\s\S]*?export function creditAction/.test(orch));
    const idx = code("index.ts");
    ck("Z5. index.ts routes F14 right after F13 and before F12; the 6 credit routes exist; nothing else", idx.indexOf("matchCreditRoute(route") > idx.indexOf("matchSupplierRoute(route") && idx.indexOf("matchCreditRoute(route") < idx.indexOf("matchCoachCostRoute(route") && matchCreditRoute("supplier-credits", "GET")?.status === "match" && matchCreditRoute("supplier-credits", "POST")?.status === "match" && matchCreditRoute(`supplier-credits/${K1}`, "GET")?.status === "match" && ["apply", "unapply", "void"].every((a) => matchCreditRoute(`supplier-credits/${K1}/${a}`, "POST")?.status === "match"));
    const NOT = [`supplier-credits/${K1}/delete`, `supplier-credits/${K1}/edit`, `supplier-credits/${K1}/auto-apply`, "supplier-credits/apply-all", `supplier-credits/${K1}/applications/FSX-AAAAAAAAAAAA`];
    ck("Z6. No delete / edit / auto-apply / bulk route; a credit is never POSTed or DELETEd in place", NOT.every((p) => matchCreditRoute(p, "POST")?.status === "not_found") && matchCreditRoute(`supplier-credits/${K1}`, "POST")?.status === "method" && matchCreditRoute(`supplier-credits/${K1}`, "DELETE")?.status === "method" && matchCreditRoute("suppliers", "GET") === null);
    const copy = (f: string) => readFileSync(join(HERE, f), "utf8").endsWith(code(f));
    ck("Z7. Test copies match the canonical files (no import changes needed)", copy("finance-supplier-credits.ts") && copy("finance-supplier-credits-orchestrator.ts"));
    const allCode = noStrings(pure + orch);
    ck("Z8. No Cash Flow, overhead / salary, Month Report, bank or payment-row code in F14 (credits are never payments)", !/cash ?flow|cashflow|overhead|salar|month ?report|reconcil|bank_feed|paymentRow|finance_supplier_payments/i.test(allCode) && !/sk_live_[A-Za-z0-9]|rk_live_[A-Za-z0-9]/.test(allCode));
    const shared = ["finance-billing-mapping.ts", "finance-billing.ts", "finance-commercial-mapping.ts", "finance-commercial.ts", "finance-effective-dating.ts", "finance-invoicing-mapping.ts", "finance-invoicing.ts", "finance-issue-mapping.ts", "finance-issue.ts", "finance-lifecycle.ts", "finance-money.ts", "finance-settings.ts"];
    ck("Z9. No F14 code in the 12 Finance modules shared with Needs Attention", shared.every((f) => !/supplier_credit|supplier-credit|creditedMinor/i.test(code(f))));
  }

  for (const [s, n, e] of R) console.log(`${s}  ${n}${s === "FAIL" && e ? `  (${e})` : ""}`);
  console.log(`\n${R.length - failed}/${R.length} checks passed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
