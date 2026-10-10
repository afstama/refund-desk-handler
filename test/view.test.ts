import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildQueue, confirmLabel, describeRefusal, describeSuccess, explain, formatMoney } from "../public/view.js";
import { policySummary } from "../src/policy.js";

// What GET /policy sends. Taken from the server's own function, so these tests cannot drift from the real numbers.
const POLICY = policySummary();

const refund = (over: Record<string, unknown> = {}) => ({
  order_id: "O-1",
  currency: "EUR",
  amount_minor: 3500,
  decision: "queued",
  reason_code: "OVER_THRESHOLD",
  decided_by: "none",
  reason: "damaged",
  note: null,
  ...over,
});
const order = (over: Record<string, unknown> = {}) => ({ status: "delivered", currency: "EUR", total_minor: 6000, refunded_minor: 0, ...over });
const ledger = (refunds: Record<string, unknown>, orders: Record<string, unknown>) => ({ orders, refunds, messages: {}, dead_letter: [], duplicates_ignored: 0, unknown_types_acked: 0 });

describe("formatMoney", () => {
  test("whole minor units, two decimals, no floats", () => {
    assert.equal(formatMoney(3500, "EUR"), "35.00 EUR");
    assert.equal(formatMoney(5, "USD"), "0.05 USD");
    assert.equal(formatMoney(0, "GBP"), "0.00 GBP");
    assert.equal(formatMoney(1999, "EUR"), "19.99 EUR");
    assert.equal(formatMoney(100000000, "EUR"), "1000000.00 EUR");
    assert.equal(formatMoney(-250, "EUR"), "-2.50 EUR");
  });

  test("something that is not a whole number is not shown as money", () => {
    for (const bad of [1.5, NaN, undefined, null, "100"]) assert.equal(formatMoney(bad as number, "EUR"), "? EUR");
  });

  test("each currency is shown with its own decimals, from the policy table: JPY 0, EUR 2, KWD 3", () => {
    assert.equal(formatMoney(1500, "JPY", POLICY), "1500 JPY");
    assert.equal(formatMoney(3500, "EUR", POLICY), "35.00 EUR");
    assert.equal(formatMoney(1234, "KWD", POLICY), "1.234 KWD");
    assert.equal(formatMoney(5, "KWD", POLICY), "0.005 KWD");
    assert.equal(formatMoney(5, "JPY", POLICY), "5 JPY");
    assert.equal(formatMoney(100, "XYZ", POLICY), "1.00 XYZ"); // unknown currency: the default, 2
  });

  test("a currency named like an Object.prototype member gets the default", () => {
    assert.equal(formatMoney(250, "constructor", POLICY), "2.50 constructor");
    assert.equal(formatMoney(250, "__proto__", POLICY), "2.50 __proto__");
  });
});

describe("explain: why the policy could not decide", () => {
  test("each queue reason has its own words, and the numbers come from the policy", () => {
    assert.match(explain({ reason_code: "NOT_DELIVERED" }, POLICY), /No delivery is recorded/);
    assert.match(explain({ reason_code: "WINDOW_EXPIRED" }, POLICY), /more than 30 days after delivery/);
    assert.match(explain({ reason_code: "OVER_THRESHOLD", note: null }, POLICY), /over the 20.00 EUR automatic limit/);
    assert.match(explain({ reason_code: "REASON_NOT_ELIGIBLE" }, POLICY), /\(damaged, wrong item, not received, missing item\)/);
  });

  test("when the policy changes, the wording follows: no number is typed in the page", () => {
    const changed = {
      ...POLICY,
      auto_approve: { window_days: 14, limit_minor: 5000, limit_currency: "EUR", eligible_reasons: ["damaged", "late_delivery"] },
    };
    assert.match(explain({ reason_code: "WINDOW_EXPIRED" }, changed), /more than 14 days after delivery/);
    assert.match(explain({ reason_code: "OVER_THRESHOLD", note: null }, changed), /over the 50.00 EUR automatic limit/);
    assert.match(explain({ reason_code: "REASON_NOT_ELIGIBLE" }, changed), /\(damaged, late delivery\)/);
    const yen = { ...changed, auto_approve: { ...changed.auto_approve, limit_minor: 3000, limit_currency: "JPY" } };
    assert.match(explain({ reason_code: "OVER_THRESHOLD", note: null }, yen), /over the 3000 JPY automatic limit/);
  });

  test("without the policy the wording stays true, just less specific", () => {
    assert.equal(explain({ reason_code: "WINDOW_EXPIRED" }, null), "It was requested after the delivery window.");
    assert.equal(explain({ reason_code: "OVER_THRESHOLD", note: null }, null), "The amount is over the automatic limit.");
    assert.equal(explain({ reason_code: "REASON_NOT_ELIGIBLE" }, undefined), "The customer's reason is not one of the automatic ones.");
  });

  test("the note decides what OVER_THRESHOLD means for a currency problem", () => {
    assert.match(explain({ reason_code: "OVER_THRESHOLD", note: "currency_mismatch" }, POLICY), /different currency than the order/);
    assert.match(explain({ reason_code: "OVER_THRESHOLD", note: "unsupported_currency" }, POLICY), /no exchange rate.*20.00 EUR/);
  });

  test("an unknown code is still shown, never hidden", () => {
    assert.match(explain({ reason_code: "SOMETHING_NEW" }, POLICY), /SOMETHING_NEW/);
  });
});

describe("buildQueue", () => {
  test("lists only queued refunds: not auto-approved, rejected, approved or parked", () => {
    const view = buildQueue(
      ledger(
        {
          "R-1": refund(),
          "R-2": refund({ decision: "auto_approved", reason_code: "AUTO_OK", decided_by: "policy" }),
          "R-3": refund({ decision: "rejected", reason_code: "EXCEEDS_BALANCE", decided_by: "policy" }),
          "R-4": refund({ decision: "approved", reason_code: "HUMAN_APPROVED", decided_by: "human" }),
          "R-5": refund({ decision: "parked", reason_code: "ORDER_UNKNOWN", order_id: "O-NOT-YET" }),
        },
        { "O-1": order() },
      ),
    );
    assert.equal(view.count, 1);
    assert.deepEqual(view.groups.map((g: { refunds: { id: string }[] }) => g.refunds.map((r) => r.id)), [["R-1"]]);
  });

  test("groups by order and sorts by order id, then refund id (O-1122 shows both refunds together)", () => {
    const view = buildQueue(
      ledger(
        {
          "R-0087": refund({ order_id: "O-1122" }),
          "R-0035": refund({ order_id: "O-1050" }),
          "R-0086": refund({ order_id: "O-1122" }),
        },
        { "O-1122": order(), "O-1050": order() },
      ),
    );
    assert.deepEqual(view.groups.map((g: { orderId: string; refunds: { id: string }[] }) => [g.orderId, g.refunds.map((r) => r.id)]), [
      ["O-1050", ["R-0035"]],
      ["O-1122", ["R-0086", "R-0087"]],
    ]);
  });

  test("the order's numbers: total, refunded, still refundable", () => {
    const view = buildQueue(ledger({ "R-1": refund() }, { "O-1": order({ total_minor: 6000, refunded_minor: 1500, status: "delivered" }) }));
    assert.deepEqual(view.groups[0]!.order, { status: "delivered", currency: "EUR", total_minor: 6000, refunded_minor: 1500, remaining_minor: 4500 });
    assert.deepEqual(view.groups[0]!.refunds[0]!.warnings, []);
  });

  test("warnings: cancelled order, currency mismatch, no longer fits, order not in the ledger", () => {
    const cancelled = buildQueue(ledger({ "R-1": refund() }, { "O-1": order({ status: "cancelled" }) }));
    assert.match(cancelled.groups[0]!.refunds[0]!.warnings[0]!, /cancelled/);

    const mismatch = buildQueue(ledger({ "R-1": refund({ currency: "EUR" }) }, { "O-1": order({ currency: "USD" }) }));
    assert.match(mismatch.groups[0]!.refunds[0]!.warnings[0]!, /refund is in EUR but the order is in USD/);

    const tight = buildQueue(ledger({ "R-1": refund({ amount_minor: 3500 }) }, { "O-1": order({ total_minor: 6000, refunded_minor: 3500 }) }));
    assert.match(tight.groups[0]!.refunds[0]!.warnings[0]!, /Only 25.00 EUR of this order is still refundable/);

    const unknown = buildQueue(ledger({ "R-1": refund({ order_id: "O-GONE" }) }, {}));
    assert.deepEqual(unknown.groups[0]!.refunds[0]!.warnings, ["This order is not in the ledger."]);
    assert.equal(unknown.groups[0]!.order, null);
  });

  test("an order id such as __proto__ or constructor is looked up as a key, not as a property", () => {
    const orders = JSON.parse('{"__proto__": {"status":"delivered","currency":"EUR","total_minor":1000,"refunded_minor":0}}');
    const view = buildQueue(ledger({ "R-1": refund({ order_id: "__proto__", amount_minor: 500 }), "R-2": refund({ order_id: "constructor" }) }, orders));
    assert.equal(view.groups.find((g) => g.orderId === "__proto__")!.order!.total_minor, 1000);
    assert.equal(view.groups.find((g) => g.orderId === "constructor")!.order, null);
  });

  test("an empty or odd ledger gives an empty queue", () => {
    assert.deepEqual(buildQueue({}), { count: 0, groups: [] });
    assert.deepEqual(buildQueue(null), { count: 0, groups: [] });
  });

  test("hostile text stays plain text in the result: nothing is escaped, nothing is interpreted", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const view = buildQueue(ledger({ "R-1": refund({ reason: evil, note: evil }) }, { "O-1": order() }));
    assert.equal(view.groups[0]!.refunds[0]!.reason, evil);
  });
});

describe("what the service answered", () => {
  test("refusals in words", () => {
    assert.equal(describeRefusal(401, { error: "unauthorized" }, "EUR"), "Sign in again.");
    assert.match(describeRefusal(404, { error: "unknown_refund" }, "EUR"), /no longer exists/);
    assert.match(describeRefusal(503, {}, "EUR"), /could not reach its database/);
    assert.match(describeRefusal(409, { error: "already_decided", refund: { decision: "approved" } }, "EUR"), /Already approved/);
    assert.match(describeRefusal(409, { error: "not_queued" }, "EUR"), /waiting for its order/);
    assert.match(describeRefusal(409, { error: "order_cancelled" }, "EUR"), /cancelled meanwhile.*still reject/);
    assert.match(describeRefusal(409, { error: "currency_mismatch" }, "EUR"), /different currency.*still reject/);
    assert.equal(
      describeRefusal(409, { error: "exceeds_balance", remaining_minor: 2500 }, "EUR"),
      "No longer fits: only 25.00 EUR of this order is still refundable. The refund stays queued.",
    );
    assert.match(describeRefusal(418, {}, "EUR"), /Unexpected answer \(418\)/);
  });

  test("success in words", () => {
    const result = { refund: { refund_id: "R-0086", order_id: "O-1122", amount_minor: 3500, currency: "EUR" }, order: { remaining_minor: 2500 } };
    assert.equal(describeSuccess("approve", result), "Approved R-0086: 35.00 EUR. 25.00 EUR of order O-1122 is still refundable.");
    assert.equal(describeSuccess("reject", result), "Rejected R-0086: 35.00 EUR. Nothing was paid.");
  });

  test("a success answer without the expected body is still reported as done", () => {
    assert.equal(describeSuccess("approve", {}), "Approved.");
    assert.equal(describeSuccess("reject", undefined), "Rejected.");
  });

  test("the confirmation names the amount that will move", () => {
    assert.equal(confirmLabel({ amount_minor: 3500, currency: "EUR" }), "Confirm approve 35.00 EUR?");
  });
});
