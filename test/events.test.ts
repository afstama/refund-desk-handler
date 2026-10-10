import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bodyIdProblem, classify, EVENT_ID_FORMAT } from "../src/events.js";
import { loadDeliveries } from "./helpers/replay.js";

const at = "2026-04-14T09:12:44+02:00";
const refund = (payload: Record<string, unknown>) => ({ id: "evt_x", type: "refund.requested", occurred_at: at, payload });
const goodRefund = { refund_id: "R-0311", order_id: "O-1042", amount: "9.99", currency: "EUR", reason: "damaged" };

function detail(body: unknown): string {
  const result = classify(body);
  assert.equal(result.ok, false, "expected the event to be refused");
  return result.ok ? "" : result.detail;
}

describe("classify: usable events", () => {
  test("order.created", () => {
    const result = classify({ id: "evt_1", type: "order.created", occurred_at: at, payload: { order_id: "O-1042", customer_email: " a@example.com ", total: "29.97", currency: "EUR", extra: "ignored" } });
    assert.deepEqual(result, {
      ok: true,
      event: { kind: "order.created", occurredAt: new Date("2026-04-14T07:12:44.000Z"), orderId: "O-1042", customerEmail: "a@example.com", currency: "EUR", totalMinor: 2997 },
    });
  });

  test("dirty but unambiguous values are normalised: spaces, reason case, number amount", () => {
    const r1 = classify(refund({ ...goodRefund, amount: " 18.40" })); // evt_0389
    const r2 = classify(refund({ ...goodRefund, reason: "DAMAGED" })); // evt_0196
    const r3 = classify(refund({ ...goodRefund, order_id: "  O-1112 " })); // evt_0379
    const r4 = classify(refund({ ...goodRefund, amount: 11.4 })); // evt_0357
    assert.ok(r1.ok && r1.event.kind === "refund.requested" && r1.event.amountMinor === 1840);
    assert.ok(r2.ok && r2.event.kind === "refund.requested" && r2.event.reason === "damaged");
    assert.ok(r3.ok && r3.event.kind === "refund.requested" && r3.event.orderId === "O-1112");
    assert.ok(r4.ok && r4.event.kind === "refund.requested" && r4.event.amountMinor === 1140);
  });

  test("ids keep their case: o-1112 is not O-1112", () => {
    const r = classify(refund({ ...goodRefund, order_id: "o-1112" }));
    assert.ok(r.ok && r.event.kind === "refund.requested" && r.event.orderId === "o-1112");
  });

  test("more than two decimals are rounded half up", () => {
    const r = classify(refund({ ...goodRefund, amount: "10.999" }));
    assert.ok(r.ok && r.event.kind === "refund.requested" && r.event.amountMinor === 1100);
  });

  test("an amount is read with the decimals of its own currency (JPY 0, EUR 2, KWD 3)", () => {
    const refundIn = (currency: string, amount: unknown) => classify(refund({ ...goodRefund, currency, amount }));
    const minor = (r: ReturnType<typeof classify>) => (r.ok && r.event.kind === "refund.requested" ? r.event.amountMinor : null);
    assert.equal(minor(refundIn("EUR", "9.99")), 999);
    assert.equal(minor(refundIn("JPY", "1500")), 1500); // 1500 yen, not 15.00
    assert.equal(minor(refundIn("JPY", "1500.5")), 1501);
    assert.equal(minor(refundIn("KWD", "1.234")), 1234);
    assert.equal(minor(refundIn("KWD", 2)), 2000);
    assert.equal(minor(refundIn("EUR", "10.999")), 1100);

    const order = (currency: string, total: unknown) =>
      classify({ id: "e", type: "order.created", occurred_at: at, payload: { order_id: "O-1", customer_email: "a@example.com", total, currency } });
    const total = (r: ReturnType<typeof classify>) => (r.ok && r.event.kind === "order.created" ? r.event.totalMinor : null);
    assert.equal(total(order("JPY", "12000")), 12000);
    assert.equal(total(order("EUR", "29.97")), 2997);
  });

  test("a currency that is not three capital letters is refused before its amount is read", () => {
    const d = detail(refund({ ...goodRefund, currency: "eur", amount: "5.00" }));
    assert.equal(d, "refund.requested: payload.currency invalid");
  });

  test("shipment.delivered and order.cancelled", () => {
    const d = classify({ id: "e", type: "shipment.delivered", occurred_at: at, payload: { order_id: "O-1" } });
    const c = classify({ id: "e", type: "order.cancelled", occurred_at: at, payload: { order_id: "O-1" } });
    assert.ok(d.ok && d.event.kind === "shipment.delivered");
    assert.ok(c.ok && c.event.kind === "order.cancelled");
  });

  test("message.received: order_id may be null or missing, text is kept as sent", () => {
    const base = { message_id: "M-0207", channel: "email", text: "  hello  " };
    const withNull = classify({ id: "e", type: "message.received", occurred_at: at, payload: { ...base, order_id: null } });
    const without = classify({ id: "e", type: "message.received", occurred_at: at, payload: base });
    const named = classify({ id: "e", type: "message.received", occurred_at: at, payload: { ...base, order_id: "O-1042" } });
    for (const r of [withNull, without]) assert.ok(r.ok && r.event.kind === "message.received" && r.event.orderId === null && r.event.text === "  hello  ");
    assert.ok(named.ok && named.event.kind === "message.received" && named.event.orderId === "O-1042");
  });

  test("an unknown but well-formed type is acknowledged, whatever its payload (evt_0114)", () => {
    const r = classify({ id: "evt_0114", type: "loyalty.points_awarded", occurred_at: at, payload: { anything: [1, 2] } });
    assert.deepEqual(r, { ok: true, event: { kind: "unknown", occurredAt: new Date("2026-04-14T07:12:44.000Z"), type: "loyalty.points_awarded" } });
  });

  test("types named after Object.prototype members are just unknown types", () => {
    for (const type of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const r = classify({ id: "e", type, occurred_at: at, payload: {} });
      assert.ok(r.ok && r.event.kind === "unknown" && r.event.type === type, type);
    }
  });
});

describe("classify: events that are refused (detail names the field, never the value)", () => {
  test("not an event object: evt_0175 null, evt_0195 a list", () => {
    assert.equal(detail(null), "body is not a JSON object");
    assert.equal(detail([1, 2, 3]), "body is not a JSON object");
    assert.equal(detail("text"), "body is not a JSON object");
    assert.equal(detail(42), "body is not a JSON object");
  });

  test("type is not a string: evt_0135", () => {
    assert.equal(detail({ id: "evt_0135", type: 42, occurred_at: at, payload: {} }), "event: type invalid");
    assert.equal(detail({ id: "e", occurred_at: at, payload: {} }), "event: type missing");
    assert.equal(detail({ id: "e", type: "", occurred_at: at, payload: {} }), "event: type invalid");
  });

  test("bad timestamp: evt_0100", () => {
    assert.equal(detail({ id: "evt_0100", type: "shipment.delivered", occurred_at: "not-a-date", payload: { order_id: "O-1120" } }), "shipment.delivered: occurred_at invalid");
    assert.equal(detail({ id: "e", type: "shipment.delivered", payload: { order_id: "O-1" } }), "shipment.delivered: occurred_at missing");
    assert.equal(detail({ id: "e", type: "loyalty.points_awarded", occurred_at: "nope", payload: {} }), "event: occurred_at invalid");
  });

  test("payload missing or not an object: evt_0073, evt_0126", () => {
    assert.equal(detail({ id: "evt_0073", type: "refund.requested", occurred_at: at }), "refund.requested: payload missing");
    assert.equal(detail({ id: "evt_0126", type: "order.created", occurred_at: at, payload: null }), "order.created: payload null");
    assert.equal(detail({ id: "e", type: "order.created", occurred_at: at, payload: [] }), "order.created: payload invalid");
  });

  test("required fields missing: evt_0148, evt_0061, evt_0360", () => {
    assert.equal(detail({ id: "evt_0148", type: "order.created", occurred_at: at, payload: { customer_email: "x@example.com", total: "19.00", currency: "EUR" } }), "order.created: payload.order_id missing");
    const { refund_id: _a, ...noRefundId } = goodRefund;
    assert.equal(detail(refund(noRefundId)), "refund.requested: payload.refund_id missing");
    const { currency: _b, ...noCurrency } = goodRefund;
    assert.equal(detail(refund(noCurrency)), "refund.requested: payload.currency missing");
  });

  test("amounts that cannot be read: evt_0124, evt_0212, evt_0350", () => {
    for (const bad of ["13,40", "abc", "-15.00"]) {
      const d = detail(refund({ ...goodRefund, amount: bad }));
      assert.equal(d, "refund.requested: payload.amount invalid");
      assert.ok(!d.includes(bad));
    }
    assert.equal(detail(refund({ ...goodRefund, amount: null })), "refund.requested: payload.amount null");
    assert.equal(detail(refund({ ...goodRefund, amount: "0.00" })), "refund.requested: payload.amount invalid");
  });

  test("currency must be three capital letters, ids must not be blank", () => {
    assert.equal(detail(refund({ ...goodRefund, currency: "eur" })), "refund.requested: payload.currency invalid");
    assert.equal(detail(refund({ ...goodRefund, currency: "EURO" })), "refund.requested: payload.currency invalid");
    assert.equal(detail(refund({ ...goodRefund, order_id: "   " })), "refund.requested: payload.order_id invalid");
  });

  test("a NUL character would break the insert, so the event is refused", () => {
    const body = { id: "e", type: "message.received", occurred_at: at, payload: { message_id: "M-1", order_id: null, channel: "email", text: "hi\u0000there" } };
    assert.equal(detail(body), "message.received: text contains a NUL character");
  });

  test("never throws on odd input", () => {
    const deep = JSON.parse("[".repeat(5000) + "]".repeat(5000));
    for (const body of [deep, { type: {}, occurred_at: [] }, Object.create(null), { type: "order.created", occurred_at: at, payload: { order_id: { toString: 1 } } }]) {
      assert.doesNotThrow(() => classify(body));
    }
  });
});

describe("EVENT_ID_FORMAT", () => {
  test("accepts any id scheme a sender is likely to use: counters, UUIDs, base64, prefixes with symbols", () => {
    const good = [
      "evt_0001",
      "evt_t4a",
      "a.b:c-d_e",
      "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      "evt_1MqLiJLkdIwHu7ixzAKbDDrf",
      "dGVzdA==",
      "AbC+/xyz=",
      "tenant/42/evt#7",
      "x".repeat(128),
    ];
    for (const id of good) assert.equal(EVENT_ID_FORMAT.test(id), true, id);
  });

  test("refuses what is not an id: empty, spaces, control characters, non-ASCII, longer than 128", () => {
    const bad = ["", "evt 0001", "<img src=x onerror=alert(1)>", "evt\t1", "evt_0001\n", "evt_é", "evt_​1", "x".repeat(129)];
    for (const id of bad) assert.equal(EVENT_ID_FORMAT.test(id), false, JSON.stringify(id));
  });

  test("every event id in events.ndjson passes", async () => {
    const bad = (await loadDeliveries()).filter((d) => !EVENT_ID_FORMAT.test(d.event_id));
    assert.deepEqual(bad.map((d) => d.event_id), []);
  });
});

describe("bodyIdProblem: the signed body must carry the id of the header", () => {
  test("same id, also with stray spaces", () => {
    assert.equal(bodyIdProblem({ id: "evt_1" }, "evt_1"), null);
    assert.equal(bodyIdProblem({ id: " evt_1 " }, "evt_1"), null);
  });

  test("bodies that are not objects are left to classify (evt_0175, evt_0195)", () => {
    for (const body of [null, [1, 2, 3], "text", 42]) assert.equal(bodyIdProblem(body, "evt_1"), null);
  });

  test("a different id names the id the body carries, when it looks like an id", () => {
    assert.equal(bodyIdProblem({ id: "evt_0114" }, "evt_replay_1"), "body id does not match X-Event-Id (body says evt_0114)");
    assert.equal(bodyIdProblem({ id: "has a space" }, "evt_1"), "body id does not match X-Event-Id");
    assert.equal(bodyIdProblem({ id: "" }, "evt_1"), "body id does not match X-Event-Id");
  });

  test("a body without a usable id is refused", () => {
    assert.equal(bodyIdProblem({ type: "order.created" }, "evt_1"), "body id missing");
    assert.equal(bodyIdProblem({ id: null }, "evt_1"), "body id null");
    assert.equal(bodyIdProblem({ id: 7 }, "evt_1"), "body id invalid");
  });

  test("in the data the body id equals the header id for every object body", async () => {
    const deliveries = await loadDeliveries();
    let checked = 0;
    const problems: string[] = [];
    for (const d of deliveries) {
      let body: unknown;
      try {
        body = JSON.parse(d.body);
      } catch {
        continue; // evt_0326, broken JSON
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) continue; // evt_0175, evt_0195
      checked++;
      const problem = bodyIdProblem(body, d.event_id);
      if (problem) problems.push(`${d.event_id}: ${problem}`);
    }
    assert.deepEqual(problems, []);
    assert.equal(checked, 418);
  });
});
