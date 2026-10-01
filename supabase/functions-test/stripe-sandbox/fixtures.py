#!/usr/bin/env python3
"""
TEST ONLY - generates the ZZTEST fixtures for the stripe-sandbox emulator
(Finance F10 live proof; see TEST-ENV.md "Finance Foundation - F10").

    python3 supabase/functions-test/stripe-sandbox/fixtures.py acct_ZZTESTf10sandbox > fixtures.sql

Prints SQL that (re)inserts Stripe-shaped objects for ONE emulator account
into public.stripe_sandbox_objects. Every object is livemode false and every
id carries ZZTEST. Nothing here is real Stripe data; there are no real
customers, cards or emails (all *@test.invalid).
"""
import json
import sys
from datetime import datetime, timezone


def T(iso: str) -> int:
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(timezone.utc).timestamp())


def price(pid, amount, interval="month", tax="exclusive"):
    return {"id": pid, "object": "price", "product": "prod_" + pid[6:], "unit_amount": amount, "currency": "gbp", "recurring": {"interval": interval, "interval_count": 1}, "tax_behavior": tax, "nickname": pid + " plan", "livemode": False}


def sub(sid, customer, status, created, **over):
    o = {
        "id": sid, "object": "subscription", "customer": customer, "status": status, "created": created,
        "current_period_start": T("2026-09-15T00:00:00Z"), "current_period_end": T("2026-10-15T00:00:00Z"),
        "cancel_at_period_end": False, "cancel_at": None, "canceled_at": None, "ended_at": None, "trial_end": None,
        "items": {"object": "list", "data": [{"id": "si_" + sid[4:], "object": "subscription_item", "price": price("price_ZZTESTppa", 5500), "quantity": 1}]},
        "latest_invoice": None, "default_tax_rates": [], "automatic_tax": {"enabled": False}, "metadata": {}, "livemode": False,
    }
    o.update(over)
    return o


def bt(bid, amount, fee, created):
    return {"id": bid, "object": "balance_transaction", "amount": amount, "fee": fee, "net": amount - fee, "currency": "gbp", "available_on": created + 7 * 86400, "fee_details": [{"type": "stripe_fee", "amount": fee}], "created": created, "livemode": False}


def charge(cid, customer, amount, status, created, **over):
    o = {"id": cid, "object": "charge", "customer": customer, "amount": amount, "amount_refunded": 0, "refunded": False, "currency": "gbp", "status": status, "paid": status == "succeeded", "created": created, "payment_intent": "pi_" + cid[3:], "invoice": None, "balance_transaction": None, "failure_code": None, "outcome": {"type": "issuer_declined" if status == "failed" else "authorized", "reason": None}, "disputed": False, "livemode": False}
    o.update(over)
    return o


def invoice(iid, sub_id, customer, status, total, created, **over):
    o = {"id": iid, "object": "invoice", "subscription": sub_id, "customer": customer, "status": status, "currency": "gbp", "total": total, "subtotal": total, "amount_due": total, "amount_paid": total if status == "paid" else 0, "amount_remaining": 0 if status == "paid" else total, "created": created, "attempt_count": 1 if status == "paid" else 0, "next_payment_attempt": None, "status_transitions": {"paid_at": created + 60 if status == "paid" else None}, "charge": None, "tax": None, "total_excluding_tax": None, "total_tax_amounts": [], "automatic_tax": {"enabled": False, "status": None}, "livemode": False}
    o.update(over)
    return o


def objects():
    out = []
    put = out.append
    TAX20 = {"id": "txr_ZZTEST20", "percentage": 20, "inclusive": False}
    # Customer A: will be linked to the TEST multi-child parent PARENT-TEST-001 during the proof.
    put({"id": "cus_ZZTESTa", "object": "customer", "name": "ZZTEST Priya Parent (Stripe)", "email": "parent.a@test.invalid", "created": T("2026-08-01T09:00:00Z"), "livemode": False})
    # Customer B: the Hub parent's exact name + email - must never be matched by them.
    put({"id": "cus_ZZTESTb", "object": "customer", "name": "Priya Parent", "email": "parent.a@test.invalid", "created": T("2026-08-01T09:01:00Z"), "livemode": False})
    put({"id": "cus_ZZTESTdel", "object": "customer", "deleted": True, "created": T("2026-08-01T09:02:00Z"), "livemode": False})
    put({"id": "cus_ZZTESTbulk", "object": "customer", "name": "ZZTEST bulk pagination customer", "email": "zztest.bulk@test.invalid", "created": T("2026-08-01T09:03:00Z"), "livemode": False})
    # A: active with Stripe tax rates (55.00 + 11.00 VAT = 66.00; fee 1.19; net 64.81).
    c1 = T("2026-09-15T06:00:00Z")
    put(bt("txn_ZZTESTok1", 6600, 119, c1))
    put(charge("ch_ZZTESTok1", "cus_ZZTESTa", 6600, "succeeded", c1, invoice="in_ZZTESTpaid1", balance_transaction="txn_ZZTESTok1"))
    put(invoice("in_ZZTESTpaid1", "sub_ZZTESTactive", "cus_ZZTESTa", "paid", 6600, c1 - 30, charge="ch_ZZTESTok1", subtotal=5500, tax=1100, total_excluding_tax=5500, total_tax_amounts=[{"amount": 1100, "inclusive": False, "tax_rate": "txr_ZZTEST20"}]))
    put(sub("sub_ZZTESTactive", "cus_ZZTESTa", "active", T("2026-08-01T10:00:10Z"), latest_invoice="in_ZZTESTpaid1", default_tax_rates=[TAX20]))
    # A: trialling.
    put(sub("sub_ZZTESTtrial", "cus_ZZTESTa", "trialing", T("2026-08-01T10:00:20Z"), trial_end=T("2026-10-08T00:00:00Z"), current_period_end=T("2026-10-08T00:00:00Z")))
    # A: past due (insufficient funds; Stripe retries 2026-10-03).
    c2 = T("2026-09-20T06:00:00Z")
    put(charge("ch_ZZTESTfail1", "cus_ZZTESTa", 8700, "failed", c2, invoice="in_ZZTESTopen1", failure_code="card_declined", outcome={"type": "issuer_declined", "reason": "insufficient_funds"}))
    put(invoice("in_ZZTESTopen1", "sub_ZZTESTpastdue", "cus_ZZTESTa", "open", 8700, c2 - 30, charge="ch_ZZTESTfail1", attempt_count=1, next_payment_attempt=T("2026-10-03T06:00:00Z")))
    put(sub("sub_ZZTESTpastdue", "cus_ZZTESTa", "past_due", T("2026-08-01T10:00:30Z"), latest_invoice="in_ZZTESTopen1", items={"object": "list", "data": [{"id": "si_ZZTESTpd", "object": "subscription_item", "price": price("price_ZZTESTu9", 8700, "month", "inclusive"), "quantity": 1}]}))
    # B: cancelling and cancelled.
    put(sub("sub_ZZTESTcancelling", "cus_ZZTESTb", "active", T("2026-08-01T10:00:40Z"), cancel_at_period_end=True, cancel_at=T("2026-10-15T00:00:00Z")))
    put(sub("sub_ZZTESTcancelled", "cus_ZZTESTb", "canceled", T("2026-08-01T10:00:50Z"), canceled_at=T("2026-09-01T10:00:00Z"), ended_at=T("2026-09-01T10:00:00Z")))
    # B: active, no tax recorded in Stripe (VAT must stay unknown).
    c3 = T("2026-09-16T06:00:00Z")
    put(bt("txn_ZZTESTok2", 5500, 103, c3))
    put(charge("ch_ZZTESTok2", "cus_ZZTESTb", 5500, "succeeded", c3, invoice="in_ZZTESTpaid2", balance_transaction="txn_ZZTESTok2"))
    put(invoice("in_ZZTESTpaid2", "sub_ZZTESTnotax", "cus_ZZTESTb", "paid", 5500, c3 - 30, charge="ch_ZZTESTok2"))
    put(sub("sub_ZZTESTnotax", "cus_ZZTESTb", "active", T("2026-08-01T10:01:00Z"), latest_invoice="in_ZZTESTpaid2"))
    # Refunds: full, partial, pending.
    c4 = T("2026-09-10T06:00:00Z")
    put(bt("txn_ZZTESTfull", 3000, 65, c4))
    put(charge("ch_ZZTESTfull", "cus_ZZTESTa", 3000, "succeeded", c4, amount_refunded=3000, refunded=True, balance_transaction="txn_ZZTESTfull"))
    put({"id": "txn_ZZTESTrefull", "object": "balance_transaction", "amount": -3000, "fee": 0, "net": -3000, "currency": "gbp", "available_on": c4 + 86400, "created": c4 + 3600, "livemode": False})
    put({"id": "re_ZZTESTfull", "object": "refund", "charge": "ch_ZZTESTfull", "payment_intent": "pi_ZZTESTfull", "amount": 3000, "currency": "gbp", "status": "succeeded", "reason": "requested_by_customer", "created": c4 + 3600, "balance_transaction": "txn_ZZTESTrefull", "livemode": False})
    put(bt("txn_ZZTESTpart", 4000, 80, c4 + 10))
    put(charge("ch_ZZTESTpart", "cus_ZZTESTb", 4000, "succeeded", c4 + 10, amount_refunded=1500, balance_transaction="txn_ZZTESTpart"))
    put({"id": "re_ZZTESTpart", "object": "refund", "charge": "ch_ZZTESTpart", "payment_intent": "pi_ZZTESTpart", "amount": 1500, "currency": "gbp", "status": "succeeded", "reason": None, "created": c4 + 7200, "balance_transaction": None, "livemode": False})
    put({"id": "re_ZZTESTpend", "object": "refund", "charge": "ch_ZZTESTok2", "payment_intent": "pi_ZZTESTok2", "amount": 500, "currency": "gbp", "status": "pending", "reason": None, "created": c4 + 9000, "balance_transaction": None, "livemode": False})
    put(charge("ch_ZZTESTpend", "cus_ZZTESTb", 2500, "pending", T("2026-09-30T10:00:00Z")))
    put(charge("ch_ZZTESTold", "cus_ZZTESTa", 1000, "succeeded", T("2026-07-01T10:00:00Z")))
    return out


def bulk_sql(acct: str) -> str:
    """101 cancelled filler subscriptions (one SQL statement) so a real 100-per-page read needs a second page."""
    tmpl = sub("sub_ZZTESTbulkNNN", "cus_ZZTESTbulk", "canceled", 0, canceled_at=T("2026-06-30T00:00:00Z"), ended_at=T("2026-06-30T00:00:00Z"))
    data = json.dumps(tmpl, separators=(",", ":")).replace("'", "''")
    base = T("2026-06-01T00:00:00Z")
    return (
        "insert into public.stripe_sandbox_objects (account_id, id, object, created, data)\n"
        f"select '{acct}', 'sub_ZZTESTbulk' || lpad(i::text, 3, '0'), 'subscription', {base} + i,\n"
        f"  jsonb_set(jsonb_set(jsonb_set('{data}'::jsonb, '{{id}}', to_jsonb('sub_ZZTESTbulk' || lpad(i::text, 3, '0'))), '{{created}}', to_jsonb({base} + i)),\n"
        "    '{items,data,0,id}', to_jsonb('si_ZZTESTbulk' || lpad(i::text, 3, '0')))\n"
        "from generate_series(0, 100) i;"
    )


def main():
    acct = sys.argv[1]
    assert acct.startswith("acct_ZZTEST")
    rows = []
    for o in objects():
        assert "ZZTEST" in o["id"] and o.get("livemode") is False
        data = json.dumps(o, separators=(",", ":")).replace("'", "''")
        rows.append(f"('{acct}','{o['id']}','{o['object']}',{o.get('created', 0)},'{data}'::jsonb)")
    print(f"delete from public.stripe_sandbox_objects where account_id = '{acct}';")
    print("insert into public.stripe_sandbox_objects (account_id, id, object, created, data) values\n" + ",\n".join(rows) + ";")
    print(bulk_sql(acct))


if __name__ == "__main__":
    main()
