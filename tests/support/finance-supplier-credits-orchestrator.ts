/**
 * Test-suite copy of the canonical finance/finance-supplier-credits-orchestrator.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). No changes.
 */
/**
 * Supplier / venue credits - orchestration (Finance Foundation F14; see
 * TEST-ENV.md "Finance Foundation - F14"). Every route authorises through F1's
 * authorizeFinance() first: View reads, Manage writes.
 *
 * Reads (View, never audited):
 *   GET  /supplier-credits[?supplierId&agreementId&status]
 *   GET  /supplier-credits/{FSC}            the credit, its cost adjustment, applications and audit history
 *
 * Writes (Manage, under the shared Finance write lock, each ONE atomic
 * database call that also writes its audit row):
 *   POST /supplier-credits                  record a credit (never applied automatically)
 *   POST /supplier-credits/{FSC}/apply      explicitly apply part / all to one instalment
 *   POST /supplier-credits/{FSC}/unapply    reverse one application (kept, marked unapplied)
 *   POST /supplier-credits/{FSC}/void       only a credit that was never applied
 *
 * A credit is not a payment, not income and not a discount. Nothing here
 * deletes a credit or an application, moves cash, or touches F13's shares.
 */
import type { FinanceCaller } from "./finance-access.ts";
import { type Instalment, auditInstalment, instalmentView, m, newId } from "./finance-suppliers.ts";
import {
  type CreditAction,
  type CreditActionInput,
  type CreditInput,
  type CreditStatus,
  type SupplierCredit,
  CREDIT_CONTRACT,
  CREDIT_EVENTS,
  applicationView,
  auditCredit,
  creditAppliedOf,
  creditAudit,
  creditStatusOf,
  creditView,
  planApply,
  planCredit,
  planUnapply,
  planVoid,
} from "./finance-supplier-credits.ts";
import { changeCredit, loadHistory, recordCredit } from "./finance-suppliers-repository.ts";
import { type Ctx, type Ok, type SFail, type SupplierDeps, fail, isFail, now, readCtx, unavailable, withLock } from "./finance-suppliers-orchestrator.ts";

const head = (ctx: Ctx) => ({ contract: CREDIT_CONTRACT, organisation: { organisationId: ctx.org.organisationId, name: ctx.org.name }, access: ctx.access, currency: "GBP" });
const view = (ctx: Ctx, c: SupplierCredit) => creditView(c, ctx.ledger.applications, ctx.ledger.creditSessions);
const supplierOf = (ctx: Ctx, id: string) => {
  const s = ctx.ledger.suppliers.find((x) => x.supplierId === id);
  return s ? { supplierId: s.supplierId, name: s.name, type: s.supplierType } : null;
};
const RULE = "A supplier credit is a separate cost adjustment (one correction, dated when recorded) and is only ever applied to an instalment when Management chooses to. It is not a payment, income or a discount.";

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------
export async function listCredits(deps: SupplierDeps, caller: FinanceCaller, q: { supplierId?: string; agreementId?: string; status?: CreditStatus }): Promise<Ok | SFail> {
  const ctx = await readCtx(deps, caller);
  if (isFail(ctx)) return ctx;
  const rows = ctx.ledger.credits
    .filter((c) => (q.supplierId ? c.supplierId === q.supplierId : true) && (q.agreementId ? c.agreementId === q.agreementId : true) && (q.status ? creditStatusOf(c, ctx.ledger.applications) === q.status : true))
    .map((c) => ({ ...view(ctx, c), supplier: supplierOf(ctx, c.supplierId) }));
  return { status: "ok", httpStatus: 200, body: { ...head(ctx), credits: rows, rule: RULE } };
}

export async function readCredit(deps: SupplierDeps, caller: FinanceCaller, creditId: string): Promise<Ok | SFail> {
  const ctx = await readCtx(deps, caller);
  if (isFail(ctx)) return ctx;
  const c = ctx.ledger.credits.find((x) => x.creditId === creditId);
  if (!c) return fail(404, "credit_not_found", `No supplier credit ${creditId}`);
  let history: Record<string, any>[];
  try {
    history = await loadHistory(deps.grants, ctx.org.organisationId, `${ctx.org.organisationId}:${creditId}`);
  } catch (e) {
    console.error(e);
    return unavailable();
  }
  const instalmentIds = new Set(ctx.ledger.applications.filter((a) => a.creditId === creditId).map((a) => a.instalmentId));
  return {
    status: "ok",
    httpStatus: 200,
    body: {
      ...head(ctx),
      credit: view(ctx, c),
      supplier: supplierOf(ctx, c.supplierId),
      instalments: ctx.ledger.instalments.filter((i) => instalmentIds.has(i.instalmentId)).map((i) => instalmentView(i, ctx.today)),
      history,
      rule: RULE,
    },
  };
}

// ---------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------
export function createCredit(deps: SupplierDeps, caller: FinanceCaller, input: CreditInput): Promise<Ok | SFail> {
  return withLock(deps, caller, async (ctx) => {
    const org = ctx.org.organisationId;
    const creditId = newId("FSC", deps.suppliers?.random);
    const supplier = ctx.ledger.suppliers.find((x) => x.supplierId === input.supplierId);
    const agreement = input.agreementId ? ctx.ledger.agreements.find((x) => x.agreementId === input.agreementId) : undefined;
    const plan = planCredit(input, { organisationId: org, creditId, today: ctx.today, supplier, agreement, allocations: ctx.ledger.allocations, existing: ctx.ledger.credits });
    if (!plan.ok) return fail(plan.httpStatus, plan.code, plan.error);
    const c: SupplierCredit = {
      organisationId: org,
      creditId,
      supplierId: input.supplierId,
      agreementId: input.agreementId,
      scope: input.scope,
      amountMinor: input.amountMinor,
      currency: "GBP",
      creditDate: input.creditDate,
      sourceType: input.sourceType,
      sourceReference: input.sourceReference,
      reason: input.reason,
      financeServiceId: plan.financeServiceId,
      programmeLabel: plan.programmeLabel,
      createdAt: now(deps).toISOString(),
      createdBy: caller.userId,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
    };
    const v = creditView(c, [], plan.sessions);
    await recordCredit(deps.grants, c, plan.sessions, [
      creditAudit({ organisationId: org, actorUserId: caller.userId, eventType: CREDIT_EVENTS.created, recordId: `${org}:${creditId}`, before: null, after: { ...auditCredit(c, []), creditDate: c.creditDate, source: v.source, costAdjustment: v.costAdjustment }, reason: c.reason, route: "POST /supplier-credits" }),
    ]);
    return { status: "ok", httpStatus: 201, body: { ...head(ctx), credit: v, supplier: supplierOf(ctx, c.supplierId), note: "Recorded only - nothing was applied to any instalment. Apply it explicitly when you choose to.", rule: RULE } };
  });
}

export function creditAction(deps: SupplierDeps, caller: FinanceCaller, creditId: string, action: CreditAction, input: CreditActionInput): Promise<Ok | SFail> {
  return withLock(deps, caller, async (ctx) => {
    const org = ctx.org.organisationId;
    const c = ctx.ledger.credits.find((x) => x.creditId === creditId);
    if (!c) return fail(404, "credit_not_found", `No supplier credit ${creditId}`);
    const apps = ctx.ledger.applications;
    const at = now(deps).toISOString();
    const route = `POST /supplier-credits/{id}/${action}`;
    const audit = (eventType: string, before: Record<string, unknown>, after: Record<string, unknown>, reason: string | null) =>
      creditAudit({ organisationId: org, actorUserId: caller.userId, eventType, recordId: `${org}:${creditId}`, before, after, reason, route });
    const expectedApplied = creditAppliedOf(c, apps);

    if (input.action === "void") {
      const plan = planVoid(c, apps, input, { actor: caller.userId, at });
      if (!plan.ok) return fail(plan.httpStatus, plan.code, plan.error);
      await changeCredit(deps.grants, c, "void", { instalment: null, appliedMinor: expectedApplied }, null, { voided_at: at, voided_by: caller.userId, void_reason: input.reason }, [
        audit(CREDIT_EVENTS.voided, auditCredit(c, apps), auditCredit(plan.credit, apps), input.reason),
      ]);
      return { status: "ok", httpStatus: 200, body: { ...head(ctx), credit: view(ctx, plan.credit), note: "Voided - kept on record; it adjusts no cost and can never be applied." } };
    }

    const instalmentId = input.action === "apply" ? input.instalmentId : apps.find((a) => a.applicationId === input.applicationId && a.creditId === creditId)?.instalmentId;
    const i: Instalment | undefined = instalmentId ? ctx.ledger.instalments.find((x) => x.instalmentId === instalmentId) : undefined;
    const plan =
      input.action === "apply"
        ? planApply(c, apps, i, input, { actor: caller.userId, at, applicationId: newId("FSX", deps.suppliers?.random) })
        : planUnapply(c, apps, i, input, { actor: caller.userId, at });
    if (!plan.ok) return fail(plan.httpStatus, plan.code, plan.error);
    const nextApps = input.action === "apply" ? [...apps, plan.application] : apps.map((a) => (a.applicationId === plan.application.applicationId ? plan.application : a));
    const before = i as Instalment;
    await changeCredit(deps.grants, c, input.action, { instalment: before, appliedMinor: expectedApplied }, plan.application, null, [
      audit(
        input.action === "apply" ? CREDIT_EVENTS.applied : CREDIT_EVENTS.unapplied,
        { ...auditCredit(c, apps), instalment: auditInstalment(before) },
        { ...auditCredit(c, nextApps), instalment: auditInstalment(plan.nextInstalment), application: applicationView(plan.application) },
        input.reason,
      ),
    ]);
    return {
      status: "ok",
      httpStatus: input.action === "apply" ? 201 : 200,
      body: {
        ...head(ctx),
        credit: creditView(c, nextApps, ctx.ledger.creditSessions),
        application: applicationView(plan.application),
        instalment: instalmentView(plan.nextInstalment, ctx.today, ctx.ledger.payments.filter((p) => p.instalmentId === before.instalmentId)),
        note:
          input.action === "apply"
            ? `${m(plan.application.amountMinor)} of supplier credit now reduces what is payable on ${before.instalmentId}. No cash moved and the cost was not reduced a second time.`
            : `The application is reversed (kept on record): ${m(plan.application.amountMinor)} is available on the credit again and payable on ${before.instalmentId} again.`,
      },
    };
  });
}
