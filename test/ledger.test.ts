import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { buildApp } from "../src/app.js";
import { closePool, getPool } from "../src/db.js";
import { assembleLedger, type Ledger, type LedgerRows } from "../src/ledger.js";
import { resetDb } from "./helpers/db.js";
import { injectSender, loadDeliveries, replay } from "./helpers/replay.js";
import { deliver, event } from "./helpers/webhook.js";

const app = buildApp();

after(async () => {
  await app.close();
  await closePool();
});

const emptyRows: LedgerRows = { orders: [], orderEvents: [], refunds: [], messages: [], deadLetter: [], duplicatesIgnored: 0, unknownTypesAcked: 0 };

async function getLedger() {
  const res = await app.inject({ method: "GET", url: "/ledger" });
  return { res, ledger: res.json() as Ledger };
}

describe("assembleLedger (no database)", () => {
  test("an empty system has the full shape", () => {
    assert.deepEqual(assembleLedger(emptyRows), {
      orders: {},
      refunds: {},
      messages: {},
      dead_letter: [],
      duplicates_ignored: 0,
      unknown_types_acked: 0,
      unmatched_order_events: {},
    });
  });

  test("unmatched_order_events lists what waits for an order we have not seen, sorted", () => {
    const refund = (id: string, orderId: string, decision: string) => ({
      refund_id: id, order_id: orderId, currency: "EUR", amount_minor: 500, decision,
      reason_code: decision === "parked" ? "ORDER_UNKNOWN" : "AUTO_OK", decided_by: decision === "parked" ? "none" : "policy", reason: "damaged", note: null,
    });
    const ledger = assembleLedger({
      ...emptyRows,
      orders: [{ order_id: "O-SEEN", currency: "EUR", total_minor: 1000, refunded_minor: 0 }],
      orderEvents: [
        { order_id: "O-Z", kind: "delivered" },
        { order_id: "O-Z", kind: "cancelled" },
        { order_id: "O-A", kind: "delivered" },
        { order_id: "O-SEEN", kind: "delivered" }, // its order is known: not unmatched
      ],
      refunds: [refund("R-2", "O-A", "parked"), refund("R-1", "O-A", "parked"), refund("R-3", "O-ONLY-REFUND", "parked"), refund("R-4", "O-SEEN", "auto_approved")],
    });
    assert.deepEqual(ledger.unmatched_order_events, {
      "O-A": { events: ["delivered"], parked_refunds: ["R-1", "R-2"] },
      "O-ONLY-REFUND": { events: [], parked_refunds: ["R-3"] },
      "O-Z": { events: ["cancelled", "delivered"], parked_refunds: [] },
    });
    assert.deepEqual(Object.keys(ledger.unmatched_order_events), ["O-A", "O-ONLY-REFUND", "O-Z"]);
  });

  test("ids named like Object.prototype members stay ordinary keys", () => {
    const ledger = assembleLedger({
      ...emptyRows,
      orders: [
        { order_id: "__proto__", currency: "EUR", total_minor: 1000, refunded_minor: 0 },
        { order_id: "constructor", currency: "USD", total_minor: 2000, refunded_minor: 0 },
      ],
      orderEvents: [{ order_id: "toString", kind: "delivered" }],
    });
    const roundTrip = JSON.parse(JSON.stringify(ledger)) as Ledger;
    assert.deepEqual(Object.keys(roundTrip.orders).sort(), ["__proto__", "constructor"]);
    assert.equal(Object.getOwnPropertyDescriptor(roundTrip.orders, "__proto__")?.value.total_minor, 1000);
    assert.deepEqual(Object.keys(roundTrip.unmatched_order_events), ["toString"]);
  });

  test("status: cancelled wins over delivered, delivered over created", () => {
    const order = (id: string) => ({ order_id: id, currency: "EUR", total_minor: 1000, refunded_minor: 0 });
    const ledger = assembleLedger({
      ...emptyRows,
      orders: [order("O-1"), order("O-2"), order("O-3"), order("O-4")],
      orderEvents: [
        { order_id: "O-2", kind: "delivered" },
        { order_id: "O-3", kind: "cancelled" },
        { order_id: "O-4", kind: "delivered" },
        { order_id: "O-4", kind: "cancelled" },
        { order_id: "O-UNKNOWN", kind: "delivered" }, // a delivery for an order we never saw is not an order
      ],
    });
    assert.deepEqual(
      Object.fromEntries(Object.entries(ledger.orders).map(([id, o]) => [id, o.status])),
      { "O-1": "created", "O-2": "delivered", "O-3": "cancelled", "O-4": "cancelled" },
    );
  });

  test("refunds keep the contract fields, plus reason and note", () => {
    const ledger = assembleLedger({
      ...emptyRows,
      refunds: [
        { refund_id: "R-1", order_id: "O-1", currency: "EUR", amount_minor: 999, decision: "queued", reason_code: "NOT_DELIVERED", decided_by: "none", reason: "not_received", note: null },
        { refund_id: "R-2", order_id: "O-2", currency: "EUR", amount_minor: 1200, decision: "queued", reason_code: "OVER_THRESHOLD", decided_by: "none", reason: "damaged", note: "currency_mismatch" },
      ],
    });
    assert.deepEqual(ledger.refunds["R-1"], {
      order_id: "O-1",
      currency: "EUR",
      amount_minor: 999,
      decision: "queued",
      reason_code: "NOT_DELIVERED",
      decided_by: "none",
      reason: "not_received",
      note: null,
    });
    assert.equal(ledger.refunds["R-2"]!.note, "currency_mismatch");
  });

  test("messages: flags is an array, and dead_letter keeps its order and detail", () => {
    const ledger = assembleLedger({
      ...emptyRows,
      messages: [{ message_id: "M-1", category: "praise", sentiment: "positive", draft_reply: "Thank you!", flags: [], auto_reply_sent: true }],
      deadLetter: [
        { event_id: "evt_2", reason: "invalid_event", detail: "order.created: payload null" },
        { event_id: "evt_1", reason: "bad_signature", detail: null },
      ],
      duplicatesIgnored: 5,
      unknownTypesAcked: 1,
    });
    assert.deepEqual(ledger.messages["M-1"]!.flags, []);
    assert.deepEqual(ledger.dead_letter.map((d) => d.event_id), ["evt_2", "evt_1"]);
    assert.equal(ledger.dead_letter[1]!.detail, null);
    assert.equal(ledger.duplicates_ignored, 5);
    assert.equal(ledger.unknown_types_acked, 1);
  });
});

describe("GET /ledger on the empty database", () => {
  before(async () => {
    await resetDb();
  });

  test("returns 200 with the full shape, JSON, and no caching", async () => {
    const { res, ledger } = await getLedger();
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"]), /application\/json/);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.deepEqual(ledger, {
      orders: {},
      refunds: {},
      messages: {},
      dead_letter: [],
      duplicates_ignored: 0,
      unknown_types_acked: 0,
      unmatched_order_events: {},
    });
  });
});

describe("GET /ledger after a full replay of events.ndjson", () => {
  let ledger: Ledger;
  let raw: string;

  before(async () => {
    await resetDb();
    await replay(injectSender(app), await loadDeliveries());
    const res = await app.inject({ method: "GET", url: "/ledger" });
    raw = res.body;
    ledger = res.json() as Ledger;
  });

  test("the contract blocks in contract order, nothing renamed, and one extra block after them", () => {
    assert.deepEqual(Object.keys(ledger), [
      "orders",
      "refunds",
      "messages",
      "dead_letter",
      "duplicates_ignored",
      "unknown_types_acked",
      "unmatched_order_events",
    ]);
  });

  test("nothing is waiting for an order once the whole file has been replayed", () => {
    assert.deepEqual(ledger.unmatched_order_events, {});
    assert.ok(Object.values(ledger.refunds).every((r) => r.decision !== "parked"));
  });

  test("orders: 121, with status from the events (110 delivered, 4 cancelled, 7 created)", () => {
    const orders = Object.values(ledger.orders);
    assert.equal(orders.length, 121);
    const by = (status: string) => orders.filter((o) => o.status === status).length;
    assert.deepEqual([by("delivered"), by("cancelled"), by("created")], [110, 4, 7]);
    assert.deepEqual(Object.keys(ledger.orders["O-1001"]!), ["status", "currency", "total_minor", "refunded_minor"]);
  });

  test("every money value is an integer, in the record's own currency", () => {
    for (const [id, o] of Object.entries(ledger.orders)) {
      assert.ok(Number.isInteger(o.total_minor) && o.total_minor > 0, `${id} total`);
      assert.ok(Number.isInteger(o.refunded_minor) && o.refunded_minor >= 0 && o.refunded_minor <= o.total_minor, `${id} refunded`);
    }
    for (const [id, r] of Object.entries(ledger.refunds)) assert.ok(Number.isInteger(r.amount_minor) && r.amount_minor > 0, `${id} amount`);
    assert.equal(ledger.orders["O-1112"]!.total_minor, 3730);
    assert.equal(ledger.orders["O-1105"]!.currency, "USD");
  });

  test("refunds equal the independent derivation, with decided_by none while queued", () => {
    const expected = JSON.parse(readFileSync(new URL("./fixtures/expected-refunds.json", import.meta.url), "utf8")) as {
      refunds: Record<string, { order_id: string; decision: string; reason_code: string; decided_by: string; note: string | null }>;
      refunded_minor: Record<string, number>;
    };
    assert.equal(Object.keys(ledger.refunds).length, 80);
    for (const [id, e] of Object.entries(expected.refunds)) {
      const r = ledger.refunds[id]!;
      assert.deepEqual(
        { order_id: r.order_id, decision: r.decision, reason_code: r.reason_code, decided_by: r.decided_by, note: r.note },
        e,
        id,
      );
      if (r.decision === "queued" || r.decision === "parked") assert.equal(r.decided_by, "none", id);
    }
    for (const [id, minor] of Object.entries(expected.refunded_minor)) assert.equal(ledger.orders[id]!.refunded_minor, minor, id);
    assert.equal(ledger.refunds["R-0075"]!.note, "currency_mismatch");
    assert.equal(ledger.refunds["R-0076"]!.reason, "damaged"); // sent as "DAMAGED", normalised
  });

  test("refunded_minor is exactly the approved refunds of each order, in this one snapshot", () => {
    const approved = new Map<string, number>();
    for (const r of Object.values(ledger.refunds)) {
      if (r.decision === "auto_approved" || r.decision === "approved") approved.set(r.order_id, (approved.get(r.order_id) ?? 0) + r.amount_minor);
    }
    for (const [id, o] of Object.entries(ledger.orders)) assert.equal(o.refunded_minor, approved.get(id) ?? 0, id);
  });

  test("dead_letter: 17 entries, each with a detail; counters 5 and 1", () => {
    assert.equal(ledger.dead_letter.length, 17);
    const reasons = ledger.dead_letter.reduce<Record<string, number>>((acc, d) => ({ ...acc, [d.reason]: (acc[d.reason] ?? 0) + 1 }), {});
    assert.deepEqual(reasons, { bad_signature: 4, invalid_json: 1, invalid_event: 12 });
    for (const d of ledger.dead_letter) assert.ok(typeof d.detail === "string" && d.detail.length > 0, d.event_id);
    assert.equal(ledger.duplicates_ignored, 5);
    assert.equal(ledger.unknown_types_acked, 1);
  });

  test("forged and refused records are not in the ledger", () => {
    assert.equal(ledger.orders["O-1102"], undefined); // evt_0319, bad signature
    for (const id of ["R-0065", "R-0066", "R-0067", "R-0068"]) assert.equal(ledger.refunds[id], undefined, id);
  });

  test("messages is empty until triage exists (phase 7), which the contract allows", () => {
    assert.deepEqual(ledger.messages, {});
  });

  test("the public response holds no email address and no message text", async () => {
    assert.ok(!raw.includes("@"), "an email address is in the ledger");
    const messages = (await getPool().query("SELECT text FROM messages WHERE length(text) < 200")).rows as { text: string }[];
    assert.ok(messages.length > 50);
    for (const m of messages) assert.ok(!raw.includes(m.text), `message text in the ledger: ${m.text.slice(0, 30)}`);
  });

  test("the answer is stable: the same database gives the same bytes", async () => {
    assert.equal((await app.inject({ method: "GET", url: "/ledger" })).body, raw);
  });
});

describe("GET /ledger in other situations", () => {
  test("the first 40 events give 28 orders and only contract values (what selfcheck.mjs checks)", async () => {
    await resetDb();
    const results = await replay(injectSender(app), await loadDeliveries(), { limit: 40 });
    assert.ok(results.every((r) => r.status >= 200 && r.status < 300));
    const { ledger } = await getLedger();
    assert.equal(Object.keys(ledger.orders).length, 28);
    for (const o of Object.values(ledger.orders)) {
      assert.ok(["created", "delivered", "cancelled"].includes(o.status));
      assert.ok(Number.isInteger(o.total_minor) && Number.isInteger(o.refunded_minor));
    }
  });

  test("a triaged message appears with the contract fields, a pending one does not", async () => {
    await resetDb();
    const message = (id: string, messageId: string) => event(id, "message.received", { message_id: messageId, order_id: null, channel: "email", text: "hello" });
    await deliver(app, "m1", message("m1", "M-DONE"));
    await deliver(app, "m2", message("m2", "M-WAIT"));
    await getPool().query(
      `UPDATE messages SET triage_status = 'done', category = 'praise', sentiment = 'positive',
         draft_reply = 'Thank you!', flags = '{injection_suspected}', auto_reply_sent = true WHERE message_id = 'M-DONE'`,
    );
    const { ledger } = await getLedger();
    assert.deepEqual(ledger.messages, {
      "M-DONE": { category: "praise", sentiment: "positive", draft_reply: "Thank you!", flags: ["injection_suspected"], auto_reply_sent: true },
    });
  });

  test("an order with both a delivery and a cancellation is cancelled", async () => {
    await resetDb();
    await deliver(app, "o1", event("o1", "order.created", { order_id: "O-BOTH", customer_email: "a@example.com", total: "10.00", currency: "EUR" }));
    await deliver(app, "o2", event("o2", "shipment.delivered", { order_id: "O-BOTH" }, "2026-04-02T10:00:00Z"));
    await deliver(app, "o3", event("o3", "order.cancelled", { order_id: "O-BOTH" }, "2026-04-03T10:00:00Z"));
    assert.equal((await getLedger()).ledger.orders["O-BOTH"]!.status, "cancelled");
  });

  test("a parked refund is listed with decided_by none and ORDER_UNKNOWN", async () => {
    await resetDb();
    await deliver(app, "p1", event("p1", "refund.requested", { refund_id: "R-PARK", order_id: "O-NOPE", amount: "5.00", currency: "EUR", reason: "damaged" }));
    const { ledger } = await getLedger();
    assert.deepEqual(ledger.refunds["R-PARK"], {
      order_id: "O-NOPE",
      currency: "EUR",
      amount_minor: 500,
      decision: "parked",
      reason_code: "ORDER_UNKNOWN",
      decided_by: "none",
      reason: "damaged",
      note: null,
    });
    assert.deepEqual(ledger.orders, {});
  });

  test("an order that never arrives shows what waits for it, and the entry goes when the order comes", async () => {
    await resetDb();
    await deliver(app, "g1", event("g1", "shipment.delivered", { order_id: "O-GHOST" }, "2026-04-05T10:00:00Z"));
    await deliver(app, "g2", event("g2", "order.cancelled", { order_id: "O-GHOST" }, "2026-04-06T10:00:00Z"));
    await deliver(app, "g3", event("g3", "refund.requested", { refund_id: "R-GHOST", order_id: "O-GHOST", amount: "5.00", currency: "EUR", reason: "damaged" }, "2026-04-07T10:00:00Z"));

    let { ledger } = await getLedger();
    assert.deepEqual(ledger.orders, {});
    assert.deepEqual(ledger.unmatched_order_events, { "O-GHOST": { events: ["cancelled", "delivered"], parked_refunds: ["R-GHOST"] } });

    // the order arrives late: everything that waited is used, and nothing is listed as waiting any more
    await deliver(app, "g4", event("g4", "order.created", { order_id: "O-GHOST", customer_email: "a@example.com", total: "20.00", currency: "EUR" }, "2026-04-01T10:00:00Z"));
    ({ ledger } = await getLedger());
    assert.deepEqual(ledger.unmatched_order_events, {});
    assert.equal(ledger.orders["O-GHOST"]!.status, "cancelled");
    assert.equal(ledger.refunds["R-GHOST"]!.decision, "rejected"); // cancelled at 04-06, refund at 04-07
  });

  test("an order id named like Object.prototype members is listed, end to end", async () => {
    await resetDb();
    await deliver(app, "x1", event("x1", "order.created", { order_id: "__proto__", customer_email: "a@example.com", total: "9.99", currency: "EUR" }));
    const { res } = await getLedger();
    const orders = (JSON.parse(res.body) as Ledger).orders;
    assert.equal(Object.getOwnPropertyDescriptor(orders, "__proto__")?.value.total_minor, 999);
  });

  test("a ledger read while events are being applied is always one consistent snapshot", async () => {
    await resetDb();
    const deliveries = (await loadDeliveries()).slice(0, 300);
    const problems: string[] = [];
    let polls = 0;
    let done = false;
    const poller = (async () => {
      while (!done) {
        const { ledger } = await getLedger();
        polls++;
        const approved = new Map<string, number>();
        for (const r of Object.values(ledger.refunds)) {
          if (r.decision === "auto_approved" || r.decision === "approved") approved.set(r.order_id, (approved.get(r.order_id) ?? 0) + r.amount_minor);
        }
        for (const [id, o] of Object.entries(ledger.orders)) {
          if (o.refunded_minor !== (approved.get(id) ?? 0)) problems.push(`poll ${polls}: ${id} refunded ${o.refunded_minor}, refunds say ${approved.get(id) ?? 0}`);
          if (o.refunded_minor > o.total_minor) problems.push(`poll ${polls}: ${id} refunded more than its total`);
        }
      }
    })();
    await replay(injectSender(app), deliveries);
    done = true;
    await poller;
    assert.ok(polls >= 5, `only ${polls} ledger reads happened during the replay`);
    assert.deepEqual(problems, []);
  });
});
