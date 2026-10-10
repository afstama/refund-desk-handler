import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AUTO_LIMIT_MINOR, convertMinor, decideRefund, policySummary, toEurMinor, WINDOW_DAYS, type OrderState, type RefundInput } from "../src/policy.js";
import { CURRENCY_DIGITS, minorUnitDigits } from "../src/currency.js";

const at = (iso: string) => new Date(iso);
const DELIVERED = at("2026-04-10T21:30:00Z");

const order = (o: Partial<OrderState> = {}): OrderState => ({
  currency: "EUR",
  totalMinor: 10_000,
  refundedMinor: 0,
  deliveredAt: DELIVERED,
  cancelledAt: null,
  ...o,
});
const refund = (r: Partial<RefundInput> = {}): RefundInput => ({
  amountMinor: 1000,
  currency: "EUR",
  reason: "damaged",
  occurredAt: at("2026-04-15T10:00:00Z"),
  ...r,
});
const outcome = (r: RefundInput, o: OrderState | null) => {
  const d = decideRefund(r, o);
  return `${d.decision}/${d.reasonCode}/${d.decidedBy}${d.note ? "/" + d.note : ""}`;
};

describe("toEurMinor", () => {
  test("fixed rates, rounded half up, whole numbers only", () => {
    assert.equal(toEurMinor(2100, "USD"), 1932); // R-0069
    assert.equal(toEurMinor(1800, "GBP"), 2106); // R-0070
    assert.equal(toEurMinor(1500, "USD"), 1380); // R-0071
    assert.equal(toEurMinor(1200, "GBP"), 1404); // R-0072
    assert.equal(toEurMinor(4000, "USD"), 3680); // R-0073
    assert.equal(toEurMinor(1750, "GBP"), 2048); // R-0074: 20.475 is exactly on the half cent
    assert.equal(toEurMinor(1234, "EUR"), 1234);
  });

  test("half a cent goes up, less than half goes down", () => {
    assert.equal(toEurMinor(5, "USD"), 5); // 4.6 -> 5
    assert.equal(toEurMinor(1, "USD"), 1); // 0.92 -> 1
    assert.equal(toEurMinor(1, "GBP"), 1); // 1.17 -> 1
    assert.equal(toEurMinor(50, "USD"), 46); // exactly 46
    assert.equal(toEurMinor(25, "GBP"), 29); // 29.25 -> 29
    assert.equal(toEurMinor(2, "GBP"), 2); // 2.34 -> 2
  });

  test("a currency without a rate is null, including names from Object.prototype", () => {
    for (const currency of ["JPY", "CHF", "", "eur", "constructor", "__proto__"]) assert.equal(toEurMinor(100, currency), null, currency);
  });

  test("a currency with other decimals converts correctly once it has a rate (JPY 0, KWD 3)", () => {
    // 1 JPY = 0.0062 EUR = 6200 millionths; 1 KWD = 3 EUR = 3 000 000 millionths
    const rates = new Map([["JPY", 6200], ["KWD", 3_000_000], ["EUR", 1_000_000]]);
    assert.equal(toEurMinor(10_000, "JPY", rates), 6200); // 10 000 yen = 62.00 EUR
    assert.equal(toEurMinor(1000, "JPY", rates), 620); // 1000 yen = 6.20 EUR
    assert.equal(toEurMinor(1, "JPY", rates), 1); // 0.0062 EUR = 0.62 cent, rounds up to 1
    assert.equal(toEurMinor(1234, "KWD", rates), 370); // 1.234 KWD = 3.702 EUR = 370.2 cents, rounded half up
  });

  test("a very large amount does not lose precision", () => {
    const rates = new Map([["USD", 920_000]]);
    assert.equal(toEurMinor(99_999_999_999_999, "USD", rates), 91_999_999_999_999); // 9 999 999 999 999.99 USD
  });
});

describe("convertMinor: one currency into another through EUR, rounded once", () => {
  test("EUR to USD and back: 12.00 EUR is 13.04 USD, 13.04 USD is 12.00 EUR", () => {
    assert.equal(convertMinor(1200, "EUR", "USD"), 1304); // 1304.35 rounds down
    assert.equal(convertMinor(1304, "USD", "EUR"), 1200); // 11.9968 rounds up
  });

  test("it agrees with toEurMinor wherever the target is EUR (R-0069 to R-0074)", () => {
    for (const [minor, currency] of [[2100, "USD"], [1800, "GBP"], [1500, "USD"], [1200, "GBP"], [4000, "USD"], [1750, "GBP"], [1, "USD"], [999_999, "GBP"]] as const) {
      assert.equal(convertMinor(minor, currency, "EUR"), toEurMinor(minor, currency), `${minor} ${currency}`);
    }
  });

  test("GBP to USD goes through EUR but is rounded only once", () => {
    // 17.50 GBP = 20.475 EUR = 22.2554 USD
    assert.equal(convertMinor(1750, "GBP", "USD"), 2226);
    // rounding through whole cents of EUR first would give 20.48 / 0.92 = 22.2608: the same here, but never assume it
    assert.equal(convertMinor(1, "GBP", "USD"), 1); // 1.27 cents
  });

  test("the same currency is the same amount, and a missing rate is null", () => {
    assert.equal(convertMinor(1234, "CHF", "CHF"), 1234);
    assert.equal(convertMinor(1234, "CHF", "USD"), null);
    assert.equal(convertMinor(1234, "USD", "CHF"), null);
    assert.equal(convertMinor(1234, "constructor", "EUR"), null);
  });

  test("decimals are respected, and a refund is never counted as nothing", () => {
    const rates = new Map([["JPY", 6200], ["KWD", 3_000_000], ["EUR", 1_000_000], ["XXX", 100_000_000]]);
    assert.equal(convertMinor(10_000, "JPY", "EUR", rates), 6200); // 10 000 yen is 62.00 EUR
    assert.equal(convertMinor(6200, "EUR", "JPY", rates), 10_000);
    assert.equal(convertMinor(1000, "EUR", "KWD", rates), 3333); // 10.00 EUR is 3.333 KWD
    assert.equal(convertMinor(1, "JPY", "KWD", rates), 2); // 1 yen is 0.00207 KWD: 2 fils
    // 1 yen against a currency worth 100 EUR: 0.0062 of its smallest unit would round to 0, and is counted as 1
    assert.equal(convertMinor(1, "JPY", "XXX", rates), 1);
  });
});

describe("one source for the policy numbers", () => {
  test("policySummary is what the rules use: the limit and the window are the same numbers", () => {
    const p = policySummary();
    assert.equal(p.auto_approve.limit_minor, AUTO_LIMIT_MINOR);
    assert.equal(p.auto_approve.window_days, WINDOW_DAYS);
    const delivered = at("2026-04-10T00:00:00Z");
    const o = order({ deliveredAt: delivered });
    // exactly the limit passes, one cent more does not
    assert.equal(outcome(refund({ amountMinor: p.auto_approve.limit_minor, occurredAt: at("2026-04-11T00:00:00Z") }), o), "auto_approved/AUTO_OK/policy");
    assert.equal(outcome(refund({ amountMinor: p.auto_approve.limit_minor + 1, occurredAt: at("2026-04-11T00:00:00Z") }), o), "queued/OVER_THRESHOLD/none");
    // exactly the window passes, one millisecond more does not
    const edge = new Date(delivered.getTime() + p.auto_approve.window_days * 86_400_000);
    assert.equal(outcome(refund({ occurredAt: edge }), o), "auto_approved/AUTO_OK/policy");
    assert.equal(outcome(refund({ occurredAt: new Date(edge.getTime() + 1) }), o), "queued/WINDOW_EXPIRED/none");
    // every listed reason is eligible, and one that is not listed is not
    for (const reason of p.auto_approve.eligible_reasons) assert.equal(outcome(refund({ reason }), o), "auto_approved/AUTO_OK/policy", reason);
    assert.equal(outcome(refund({ reason: "changed_mind" }), o), "queued/REASON_NOT_ELIGIBLE/none");
  });

  test("the rates are Marko's: 1 USD = 0.92 EUR and 1 GBP = 1.17 EUR, in millionths", () => {
    const p = policySummary();
    assert.deepEqual(p.eur_per_unit_micro, { EUR: 1_000_000, USD: 920_000, GBP: 1_170_000 });
  });

  test("the decimals table: the exceptions are listed, everything else is 2", () => {
    const p = policySummary();
    assert.equal(p.currency_digits.default, 2);
    assert.equal(p.currency_digits.JPY, 0);
    assert.equal(p.currency_digits.KWD, 3);
    assert.equal(p.currency_digits.CLF, 4);
    assert.equal(minorUnitDigits("EUR"), 2);
    assert.equal(minorUnitDigits("JPY"), 0);
    assert.equal(minorUnitDigits("constructor"), 2);
    assert.equal(minorUnitDigits("__proto__"), 2);
    assert.ok(!("EUR" in CURRENCY_DIGITS), "the default currencies are not listed");
  });
});

describe("decideRefund: the order of the checks", () => {
  test("an unknown order is parked (POLICY.md section 5)", () => {
    assert.equal(outcome(refund(), null), "parked/ORDER_UNKNOWN/none");
  });

  test("a cancelled order is rejected before anything else, even a tiny eligible refund", () => {
    const cancelledAt = at("2026-04-12T10:00:00Z"); // before the default refund time, 2026-04-15
    assert.equal(outcome(refund(), order({ cancelledAt })), "rejected/ORDER_CANCELLED/policy");
    assert.equal(outcome(refund({ amountMinor: 100_000 }), order({ cancelledAt })), "rejected/ORDER_CANCELLED/policy");
  });

  test("a cancellation counts only for refunds made at or after it, on the timestamps (audit finding A)", () => {
    const cancelledAt = at("2026-04-12T10:00:00Z");
    const o = order({ cancelledAt });
    assert.equal(outcome(refund({ occurredAt: at("2026-04-12T09:59:59Z") }), o), "auto_approved/AUTO_OK/policy"); // refund happened first
    assert.equal(outcome(refund({ occurredAt: at("2026-04-12T10:00:00Z") }), o), "rejected/ORDER_CANCELLED/policy"); // same instant
    assert.equal(outcome(refund({ occurredAt: at("2026-04-12T10:00:01Z") }), o), "rejected/ORDER_CANCELLED/policy");
    // the same instant written with another offset
    assert.equal(outcome(refund({ occurredAt: new Date("2026-04-12T11:59:59+02:00") }), o), "auto_approved/AUTO_OK/policy");
  });

  test("over the balance is rejected before auto-approve and before queueing", () => {
    assert.equal(outcome(refund({ amountMinor: 1501 }), order({ totalMinor: 2500, refundedMinor: 1000 })), "rejected/EXCEEDS_BALANCE/policy");
    assert.equal(outcome(refund({ amountMinor: 1501, reason: "changed_mind" }), order({ totalMinor: 2500, refundedMinor: 1000 })), "rejected/EXCEEDS_BALANCE/policy");
  });

  test("the balance may be used up exactly: 'more than' is the rule (O-1087 to O-1089)", () => {
    assert.equal(outcome(refund({ amountMinor: 1500 }), order({ totalMinor: 2500, refundedMinor: 1000 })), "auto_approved/AUTO_OK/policy");
    assert.equal(outcome(refund({ amountMinor: 1471 }), order({ totalMinor: 4391, refundedMinor: 2920 })), "auto_approved/AUTO_OK/policy");
  });

  test("a refund over the balance on an undelivered order is still a rejection, not NOT_DELIVERED", () => {
    assert.equal(outcome(refund({ amountMinor: 20_000 }), order({ deliveredAt: null })), "rejected/EXCEEDS_BALANCE/policy");
  });
});

describe("decideRefund: auto-approve and the four queue reasons", () => {
  test("all four eligible reasons are approved", () => {
    for (const reason of ["damaged", "wrong_item", "not_received", "missing_item"]) assert.equal(outcome(refund({ reason }), order()), "auto_approved/AUTO_OK/policy", reason);
  });

  test("the amount limit is 20.00 EUR inclusive (evt_0397 and evt_0395)", () => {
    assert.equal(outcome(refund({ amountMinor: 2000 }), order()), "auto_approved/AUTO_OK/policy");
    assert.equal(outcome(refund({ amountMinor: 2001 }), order()), "queued/OVER_THRESHOLD/none");
  });

  test("the window is 30 x 24 hours inclusive, on instants (R-0058, R-0059, R-0060)", () => {
    const delivered = at("2026-04-10T21:30:00Z");
    const o = order({ deliveredAt: delivered });
    assert.equal(outcome(refund({ occurredAt: at("2026-05-10T20:30:00Z") }), o), "auto_approved/AUTO_OK/policy"); // 29 d 23 h
    assert.equal(outcome(refund({ occurredAt: at("2026-05-10T21:30:00Z") }), o), "auto_approved/AUTO_OK/policy"); // exactly 30 d
    assert.equal(outcome(refund({ occurredAt: at("2026-05-10T21:30:00.001Z") }), o), "queued/WINDOW_EXPIRED/none"); // 1 ms over
    assert.equal(outcome(refund({ occurredAt: at("2026-05-10T22:30:00Z") }), o), "queued/WINDOW_EXPIRED/none"); // 30 d 1 h
    // the same instant written with another offset
    assert.equal(outcome(refund({ occurredAt: new Date("2026-05-10T23:30:00+02:00") }), o), "auto_approved/AUTO_OK/policy");
  });

  test("not delivered comes first, then window, then amount, then reason", () => {
    const late = at("2026-06-20T10:00:00Z");
    assert.equal(outcome(refund({ amountMinor: 5000, reason: "changed_mind" }), order({ deliveredAt: null })), "queued/NOT_DELIVERED/none");
    assert.equal(outcome(refund({ amountMinor: 5000, reason: "changed_mind", occurredAt: late }), order()), "queued/WINDOW_EXPIRED/none");
    assert.equal(outcome(refund({ amountMinor: 5000, reason: "changed_mind" }), order()), "queued/OVER_THRESHOLD/none");
    assert.equal(outcome(refund({ reason: "changed_mind" }), order()), "queued/REASON_NOT_ELIGIBLE/none");
    for (const reason of ["allergic_reaction", "changed_mind", "no_longer_needed"]) assert.equal(outcome(refund({ reason }), order()), "queued/REASON_NOT_ELIGIBLE/none", reason);
  });

  test("not_received on a never-delivered order stays queued as NOT_DELIVERED (R-0035 to R-0039)", () => {
    assert.equal(outcome(refund({ reason: "not_received" }), order({ deliveredAt: null })), "queued/NOT_DELIVERED/none");
  });

  test("a delivery stamped after the refund does not count as delivered at that time", () => {
    assert.equal(outcome(refund({ occurredAt: at("2026-04-09T10:00:00Z") }), order()), "queued/NOT_DELIVERED/none");
  });
});

describe("decideRefund: money and currency", () => {
  const usd = (o: Partial<OrderState> = {}) => order({ currency: "USD", totalMinor: 9000, ...o });
  const gbp = (o: Partial<OrderState> = {}) => order({ currency: "GBP", totalMinor: 7000, ...o });

  test("the 20.00 EUR limit is applied after conversion (R-0069 to R-0074)", () => {
    assert.equal(outcome(refund({ amountMinor: 2100, currency: "USD" }), usd()), "auto_approved/AUTO_OK/policy"); // 19.32 EUR
    assert.equal(outcome(refund({ amountMinor: 1800, currency: "GBP" }), gbp()), "queued/OVER_THRESHOLD/none"); // 21.06 EUR
    assert.equal(outcome(refund({ amountMinor: 1500, currency: "USD" }), usd()), "auto_approved/AUTO_OK/policy"); // 13.80 EUR
    assert.equal(outcome(refund({ amountMinor: 1200, currency: "GBP" }), gbp()), "auto_approved/AUTO_OK/policy"); // 14.04 EUR
    assert.equal(outcome(refund({ amountMinor: 4000, currency: "USD" }), usd()), "queued/OVER_THRESHOLD/none"); // 36.80 EUR
    assert.equal(outcome(refund({ amountMinor: 1750, currency: "GBP" }), gbp()), "queued/OVER_THRESHOLD/none"); // 20.48 EUR
    // the real boundary in GBP: 17.09 GBP is 19.9953 -> 20.00 EUR (allowed), 17.10 GBP is 20.007 -> 20.01 EUR (over)
    assert.equal(outcome(refund({ amountMinor: 1709, currency: "GBP" }), gbp()), "auto_approved/AUTO_OK/policy");
    assert.equal(outcome(refund({ amountMinor: 1710, currency: "GBP" }), gbp()), "queued/OVER_THRESHOLD/none");
  });

  test("the balance is checked in the order's own currency, before conversion", () => {
    assert.equal(outcome(refund({ amountMinor: 2100, currency: "USD" }), usd({ totalMinor: 2000 })), "rejected/EXCEEDS_BALANCE/policy");
  });

  test("a refund in another currency than its order goes to a human (R-0075)", () => {
    assert.equal(outcome(refund({ amountMinor: 1200, currency: "EUR" }), usd({ totalMinor: 6500 })), "queued/OVER_THRESHOLD/none/currency_mismatch");
    assert.equal(outcome(refund({ amountMinor: 1200, currency: "USD" }), order()), "queued/OVER_THRESHOLD/none/currency_mismatch");
  });

  test("a mismatch skips the balance check but a cancelled order is still rejected", () => {
    assert.equal(outcome(refund({ amountMinor: 999_999, currency: "EUR" }), usd({ totalMinor: 6500 })), "queued/OVER_THRESHOLD/none/currency_mismatch");
    assert.equal(outcome(refund({ currency: "EUR" }), usd({ cancelledAt: at("2026-04-12T10:00:00Z") })), "rejected/ORDER_CANCELLED/policy");
  });

  test("a currency without a rate goes to a human, even when order and refund agree", () => {
    const jpy = order({ currency: "JPY", totalMinor: 100_000 });
    assert.equal(outcome(refund({ amountMinor: 500, currency: "JPY" }), jpy), "queued/OVER_THRESHOLD/none/unsupported_currency");
    assert.equal(outcome(refund({ amountMinor: 200_000, currency: "JPY" }), jpy), "rejected/EXCEEDS_BALANCE/policy");
  });

  test("a currency problem keeps the order of POLICY.md section 4: delivery, then window, then the amount rule", () => {
    const late = at("2026-06-20T10:00:00Z");
    const eurOnUsd = (r: Partial<RefundInput> = {}) => refund({ amountMinor: 1200, currency: "EUR", ...r });
    // a refund in another currency than its order
    assert.equal(outcome(eurOnUsd(), usd({ deliveredAt: null })), "queued/NOT_DELIVERED/none/currency_mismatch");
    assert.equal(outcome(eurOnUsd({ occurredAt: late }), usd()), "queued/WINDOW_EXPIRED/none/currency_mismatch");
    assert.equal(outcome(eurOnUsd(), usd()), "queued/OVER_THRESHOLD/none/currency_mismatch");
    // the amount rule comes before the reason, so an ineligible reason does not hide the currency problem
    assert.equal(outcome(eurOnUsd({ reason: "changed_mind" }), usd()), "queued/OVER_THRESHOLD/none/currency_mismatch");
    // a currency without a rate, on an order in the same currency
    const jpy = (o: Partial<OrderState> = {}) => order({ currency: "JPY", totalMinor: 100_000, ...o });
    const yen = (r: Partial<RefundInput> = {}) => refund({ amountMinor: 500, currency: "JPY", ...r });
    assert.equal(outcome(yen(), jpy({ deliveredAt: null })), "queued/NOT_DELIVERED/none/unsupported_currency");
    assert.equal(outcome(yen({ occurredAt: late }), jpy()), "queued/WINDOW_EXPIRED/none/unsupported_currency");
    assert.equal(outcome(yen({ reason: "changed_mind" }), jpy()), "queued/OVER_THRESHOLD/none/unsupported_currency");
    // a mismatch is never approved automatically, however small and however eligible
    assert.equal(decideRefund(refund({ amountMinor: 1, currency: "EUR" }), usd()).decision, "queued");
  });

  test("never mutates its inputs", () => {
    const o = order();
    const before = JSON.stringify(o);
    decideRefund(refund(), o);
    assert.equal(JSON.stringify(o), before);
  });
});
