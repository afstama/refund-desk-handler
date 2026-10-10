import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { buildApp } from "../src/app.js";
import { closePool, getPool } from "../src/db.js";
import { resetDb } from "./helpers/db.js";
import { injectSender, loadDeliveries, replay, type ReplayResult } from "./helpers/replay.js";
import { deliver, event, orderCreated, sign } from "./helpers/webhook.js";

const app = buildApp();

after(async () => {
  await app.close();
  await closePool();
});

async function one<T = number>(sql: string, params: unknown[] = []): Promise<T> {
  const res = await getPool().query(sql, params);
  return Object.values(res.rows[0])[0] as T;
}

async function snapshot() {
  const q = (table: string, where = "true") => one<number>(`SELECT count(*)::int FROM ${table} WHERE ${where}`);
  return {
    events: await q("events"),
    orders: await q("orders"),
    delivered: await q("order_events", "kind = 'delivered'"),
    cancelled: await q("order_events", "kind = 'cancelled'"),
    messages: await q("messages"),
    deadLetter: await q("dead_letter"),
    redeliveries: await one<number>("SELECT COALESCE(sum(redeliveries), 0)::int FROM events"),
    refunds: await q("refunds"),
    refundedMinor: await one<number>("SELECT COALESCE(sum(refunded_minor), 0)::bigint FROM orders"),
    decisions: await one<string>("SELECT COALESCE(string_agg(refund_id || ':' || decision || ':' || reason_code, ',' ORDER BY refund_id), '') FROM refunds"),
  };
}

describe("full replay of events.ndjson", () => {
  let results: ReplayResult[] = [];
  let seconds = 0;

  before(async () => {
    await resetDb();
    const started = Date.now();
    results = await replay(injectSender(app), await loadDeliveries());
    seconds = (Date.now() - started) / 1000;
  });

  test("answers 401 for the 4 bad signatures, 400 for the broken JSON, 200 for everything else", () => {
    const by = (status: number) => results.filter((r) => r.status === status).map((r) => r.event_id);
    assert.equal(results.length, 421);
    assert.deepEqual(by(401), ["evt_0241", "evt_0319", "evt_0384", "evt_0386"]);
    assert.deepEqual(by(400), ["evt_0326"]);
    assert.equal(by(200).length, 416);
    console.log(`full replay took ${seconds.toFixed(1)} s`);
  });

  test("dead_letter has 17 entries: 4 bad_signature, 1 invalid_json, 12 invalid_event", async () => {
    const rows = (await getPool().query("SELECT event_id, reason FROM dead_letter ORDER BY event_id")).rows as { event_id: string; reason: string }[];
    const ids = (reason: string) => rows.filter((r) => r.reason === reason).map((r) => r.event_id);
    assert.equal(rows.length, 17);
    assert.deepEqual(ids("bad_signature"), ["evt_0241", "evt_0319", "evt_0384", "evt_0386"]);
    assert.deepEqual(ids("invalid_json"), ["evt_0326"]);
    assert.deepEqual(ids("invalid_event"), [
      "evt_0061", "evt_0073", "evt_0100", "evt_0124", "evt_0126", "evt_0135",
      "evt_0148", "evt_0175", "evt_0195", "evt_0212", "evt_0350", "evt_0360",
    ]);
  });

  test("every refused event carries a detail that names a field and not a value", async () => {
    const rows = (await getPool().query("SELECT event_id, reason, detail FROM dead_letter")).rows as { event_id: string; reason: string; detail: string }[];
    for (const r of rows) assert.ok(r.detail && r.detail.length < 100, `${r.event_id} has no usable detail`);
    const detail = (id: string) => rows.find((r) => r.event_id === id)!.detail;
    assert.equal(detail("evt_0175"), "body is not a JSON object");
    assert.equal(detail("evt_0135"), "event: type invalid");
    assert.equal(detail("evt_0100"), "shipment.delivered: occurred_at invalid");
    assert.equal(detail("evt_0073"), "refund.requested: payload missing");
    assert.equal(detail("evt_0126"), "order.created: payload null");
    assert.equal(detail("evt_0148"), "order.created: payload.order_id missing");
    assert.equal(detail("evt_0061"), "refund.requested: payload.refund_id missing");
    assert.equal(detail("evt_0360"), "refund.requested: payload.currency missing");
    for (const id of ["evt_0124", "evt_0212", "evt_0350"]) assert.equal(detail(id), "refund.requested: payload.amount invalid");
  });

  test("counts: 5 duplicates, 1 unknown type, 399 stored events", async () => {
    assert.equal(await one("SELECT COALESCE(sum(redeliveries), 0)::int FROM events"), 5);
    assert.equal(await one("SELECT count(*)::int FROM events WHERE outcome = 'unknown_type'"), 1);
    assert.equal(await one("SELECT type FROM events WHERE outcome = 'unknown_type'"), "loyalty.points_awarded");
    assert.equal(await one("SELECT count(*)::int FROM events"), 399);
    const dups = (await getPool().query("SELECT event_id FROM events WHERE redeliveries > 0 ORDER BY event_id")).rows.map((r) => r.event_id);
    assert.deepEqual(dups, ["evt_0083", "evt_0255", "evt_0317", "evt_0363", "evt_0376"]);
  });

  test("state: 121 orders, 110 delivered, 4 cancelled, 83 messages, 80 refund events", async () => {
    const s = await snapshot();
    assert.equal(s.orders, 121);
    assert.equal(s.delivered, 110);
    assert.equal(s.cancelled, 4);
    assert.equal(s.messages, 83);
    assert.equal(await one("SELECT count(*)::int FROM events WHERE type = 'refund.requested'"), 80);
    // the stored events add up: 121 + 110 + 4 + 83 + 80 + 1 unknown = 399
    assert.equal(s.orders + s.delivered + s.cancelled + s.messages + 80 + 1, s.events);
  });

  test("forged and refused events leave no trace", async () => {
    assert.equal(await one("SELECT count(*)::int FROM orders WHERE order_id = 'O-1102'"), 0); // evt_0319, bad signature
    assert.equal(await one("SELECT count(*)::int FROM events WHERE event_id = ANY($1)", [["evt_0241", "evt_0319", "evt_0384", "evt_0386", "evt_0326"]]), 0);
    assert.equal(await one("SELECT count(*)::int FROM messages WHERE message_id = 'M-9998'"), 0); // evt_0326, broken JSON
    assert.equal(await one("SELECT count(*)::int FROM order_events WHERE event_id = 'evt_0100'"), 0); // unreadable timestamp
  });

  test("late orders: deliveries that arrived before their order.created are kept (O-1095 to O-1097)", async () => {
    for (const orderId of ["O-1095", "O-1096", "O-1097"]) {
      assert.equal(await one("SELECT count(*)::int FROM orders WHERE order_id = $1", [orderId]), 1, `${orderId} order`);
      assert.equal(await one("SELECT count(*)::int FROM order_events WHERE order_id = $1 AND kind = 'delivered'", [orderId]), 1, `${orderId} delivery`);
    }
    assert.equal(await one("SELECT count(*)::int FROM order_events e WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.order_id = e.order_id)"), 0);
  });

  test("order totals are whole minor units", async () => {
    assert.equal(await one("SELECT total_minor FROM orders WHERE order_id = 'O-1112'"), 3730); // 37.30 EUR, a number, not text
    assert.equal(await one("SELECT count(*)::int FROM orders WHERE total_minor <= 0"), 0);
  });

  test("every refund decision equals the independent derivation (test/fixtures/expected-refunds.json)", async () => {
    const expected = JSON.parse(readFileSync(new URL("./fixtures/expected-refunds.json", import.meta.url), "utf8")) as {
      refunds: Record<string, { order_id: string; decision: string; reason_code: string; decided_by: string; note: string | null }>;
      refunded_minor: Record<string, number>;
    };
    const rows = (await getPool().query("SELECT refund_id, order_id, decision, reason_code, decided_by, note FROM refunds ORDER BY refund_id")).rows;
    assert.equal(rows.length, 80);
    const actual = Object.fromEntries(
      rows.map((r) => [r.refund_id, { order_id: r.order_id, decision: r.decision, reason_code: r.reason_code, decided_by: r.decided_by, note: r.note }]),
    );
    assert.deepEqual(actual, expected.refunds);

    const refunded = Object.fromEntries((await getPool().query("SELECT order_id, refunded_minor FROM orders WHERE refunded_minor > 0 ORDER BY order_id")).rows.map((r) => [r.order_id, r.refunded_minor]));
    assert.deepEqual(refunded, expected.refunded_minor);
  });

  test("the totals: 36 approved, 36 queued, 8 rejected, none parked, 48202 minor units refunded", async () => {
    const tally = Object.fromEntries((await getPool().query("SELECT decision, count(*)::int AS n FROM refunds GROUP BY decision")).rows.map((r) => [r.decision, r.n]));
    assert.deepEqual(tally, { auto_approved: 36, queued: 36, rejected: 8 });
    assert.equal(await one("SELECT COALESCE(sum(refunded_minor), 0)::bigint FROM orders"), 48202);
  });

  test("an order is never refunded for more than it is worth, and refunded_minor is exactly its approved refunds", async () => {
    assert.equal(await one("SELECT count(*)::int FROM orders WHERE refunded_minor > total_minor"), 0);
    assert.equal(
      await one(`SELECT count(*)::int FROM orders o WHERE o.refunded_minor <>
                 COALESCE((SELECT sum(r.amount_minor) FROM refunds r WHERE r.order_id = o.order_id AND r.decision IN ('auto_approved', 'approved')), 0)`),
      0,
    );
  });

  test("named cases from EDGE_CASES.md", async () => {
    const row = async (id: string) => (await getPool().query("SELECT order_id, decision, reason_code, decided_by FROM refunds WHERE refund_id = $1", [id])).rows[0];
    assert.deepEqual(await row("R-0058"), { order_id: "O-1092", decision: "auto_approved", reason_code: "AUTO_OK", decided_by: "policy" }); // 29 d 23 h
    assert.deepEqual(await row("R-0059"), { order_id: "O-1093", decision: "auto_approved", reason_code: "AUTO_OK", decided_by: "policy" }); // exactly 30 d
    assert.deepEqual(await row("R-0060"), { order_id: "O-1094", decision: "queued", reason_code: "WINDOW_EXPIRED", decided_by: "none" }); // 30 d 1 h
    assert.deepEqual(await row("R-0057"), { order_id: "O-1091", decision: "rejected", reason_code: "EXCEEDS_BALANCE", decided_by: "policy" });
    assert.deepEqual(await row("R-0076"), { order_id: "O-1112", decision: "auto_approved", reason_code: "AUTO_OK", decided_by: "policy" }); // "  O-1112 "
    assert.equal(await one("SELECT refunded_minor FROM orders WHERE order_id = 'O-1112'"), 1940);
    assert.equal(await one("SELECT refunded_minor FROM orders WHERE order_id = 'O-1087'"), 4391); // exactly its total
    for (const id of ["R-0040", "R-0041", "R-0042", "R-0043"]) assert.equal((await row(id)).reason_code, "ORDER_CANCELLED", id);
    for (const id of ["R-0069", "R-0071", "R-0072"]) assert.equal((await row(id)).reason_code, "AUTO_OK", id);
    for (const id of ["R-0070", "R-0073", "R-0074"]) assert.equal((await row(id)).reason_code, "OVER_THRESHOLD", id);
    assert.deepEqual((await getPool().query("SELECT decision, reason_code, note FROM refunds WHERE refund_id = 'R-0075'")).rows[0], {
      decision: "queued",
      reason_code: "OVER_THRESHOLD",
      note: "currency_mismatch",
    });
    // the four that were parked when they arrived
    assert.deepEqual(
      (await getPool().query("SELECT refund_id, decision, reason_code FROM refunds WHERE refund_id IN ('R-0061','R-0062','R-0063','R-0064') ORDER BY refund_id")).rows,
      [
        { refund_id: "R-0061", decision: "auto_approved", reason_code: "AUTO_OK" },
        { refund_id: "R-0062", decision: "auto_approved", reason_code: "AUTO_OK" },
        { refund_id: "R-0063", decision: "queued", reason_code: "OVER_THRESHOLD" },
        { refund_id: "R-0064", decision: "queued", reason_code: "NOT_DELIVERED" },
      ],
    );
  });

  test("refused and forged refunds leave no refund row", async () => {
    const ids = ["R-0065", "R-0066", "R-0067", "R-0068", "R-0080", "R-0082", "R-0083"]; // no currency, forged x3, unreadable amounts x3
    assert.equal(await one("SELECT count(*)::int FROM refunds WHERE refund_id = ANY($1)", [ids]), 0);
    // sent twice, decided once: R-0002 and R-0003
    assert.equal(await one("SELECT count(*)::int FROM refunds WHERE refund_id IN ('R-0002', 'R-0003')"), 2);
  });

  test("replaying everything again changes nothing except the duplicate count", async () => {
    const before = await snapshot();
    const second = await replay(injectSender(app), await loadDeliveries());
    const after = await snapshot();
    assert.equal(second.filter((r) => r.status === 401).length, 4);
    assert.equal(second.filter((r) => r.status === 400).length, 1);
    assert.equal(second.filter((r) => r.status === 200).length, 416);
    assert.deepEqual({ ...after, redeliveries: 0 }, { ...before, redeliveries: 0 });
    assert.equal(after.deadLetter, 17);
    // every stored event was delivered again: 399 unique events plus the 5 that were already sent twice
    assert.equal(after.redeliveries - before.redeliveries, 404);
  });
});

describe("conflicts, races, outages and bad requests", () => {
  test("same event id with a different body: first wins, the later one is dead-lettered", async () => {
    await resetDb();
    const first = orderCreated("evt_t1", "O-T1", "10.00");
    const changed = orderCreated("evt_t1", "O-T1", "99.00");
    assert.deepEqual((await deliver(app, "evt_t1", first)).json, { status: "accepted" });

    assert.deepEqual((await deliver(app, "evt_t1", changed)).json, { status: "dead_lettered" });
    assert.equal(await one("SELECT total_minor FROM orders WHERE order_id = 'O-T1'"), 1000);
    assert.equal(await one("SELECT body FROM events WHERE event_id = 'evt_t1'"), first);
    assert.equal(await one("SELECT detail FROM dead_letter WHERE event_id = 'evt_t1'"), "same event id with a different body");

    // sending the changed one again adds no second entry and is not counted as a duplicate
    await deliver(app, "evt_t1", changed);
    assert.equal(await one("SELECT count(*)::int FROM dead_letter WHERE event_id = 'evt_t1'"), 1);
    assert.equal(await one("SELECT redeliveries FROM events WHERE event_id = 'evt_t1'"), 0);
    // the original, sent again, is an ordinary duplicate
    assert.deepEqual((await deliver(app, "evt_t1", first)).json, { status: "duplicate" });
    assert.equal(await one("SELECT redeliveries FROM events WHERE event_id = 'evt_t1'"), 1);
  });

  test("a second order.created for the same order is refused and leaves no event row behind", async () => {
    await resetDb();
    await deliver(app, "evt_t2", orderCreated("evt_t2", "O-T2", "10.00"));
    assert.deepEqual((await deliver(app, "evt_t3", orderCreated("evt_t3", "O-T2", "55.00"))).json, { status: "dead_lettered" });
    assert.equal(await one("SELECT total_minor FROM orders WHERE order_id = 'O-T2'"), 1000);
    assert.equal(await one("SELECT count(*)::int FROM events WHERE event_id = 'evt_t3'"), 0);
    assert.equal(await one("SELECT detail FROM dead_letter WHERE event_id = 'evt_t3'"), "order already exists");
  });

  test("a second delivered, cancelled or message with the same business id is refused the same way", async () => {
    await resetDb();
    const delivered = (id: string) => event(id, "shipment.delivered", { order_id: "O-T3" });
    const cancelled = (id: string) => event(id, "order.cancelled", { order_id: "O-T3" });
    const message = (id: string) => event(id, "message.received", { message_id: "M-T3", order_id: null, channel: "email", text: "hi" });
    for (const make of [delivered, cancelled, message]) {
      assert.equal((await deliver(app, `${make.name}_1`, make(`${make.name}_1`))).json.status, "accepted");
      assert.equal((await deliver(app, `${make.name}_2`, make(`${make.name}_2`))).json.status, "dead_lettered");
    }
    assert.equal(await one("SELECT count(*)::int FROM dead_letter"), 3);
  });

  test("a delivery that arrives before its order is kept, and the order can follow", async () => {
    await resetDb();
    assert.equal((await deliver(app, "evt_t4a", event("evt_t4a", "shipment.delivered", { order_id: "O-T4" }, "2026-04-05T10:00:00Z"))).json.status, "accepted");
    assert.equal(await one("SELECT count(*)::int FROM orders"), 0);
    assert.equal((await deliver(app, "evt_t4b", orderCreated("evt_t4b", "O-T4"))).json.status, "accepted");
    assert.equal(await one("SELECT count(*)::int FROM orders WHERE order_id = 'O-T4'"), 1);
    assert.equal(await one("SELECT count(*)::int FROM order_events WHERE order_id = 'O-T4'"), 1);
  });

  test("four simultaneous deliveries of one event: one accepted, three duplicates, one order", async () => {
    await resetDb();
    const body = orderCreated("evt_t5", "O-T5");
    const answers = await Promise.all([1, 2, 3, 4].map(() => deliver(app, "evt_t5", body)));
    assert.deepEqual(answers.map((a) => a.json.status).sort(), ["accepted", "duplicate", "duplicate", "duplicate"]);
    assert.equal(await one("SELECT redeliveries FROM events WHERE event_id = 'evt_t5'"), 3);
    assert.equal(await one("SELECT count(*)::int FROM orders"), 1);
  });

  test("a database failure answers 503 so the sender retries, and records nothing", async () => {
    await resetDb();
    const failing = buildApp({ apply: async () => { throw new Error("db down"); } });
    const res = await deliver(failing, "evt_t6", orderCreated("evt_t6", "O-T6"));
    assert.equal(res.status, 503);
    assert.equal(await one("SELECT count(*)::int FROM dead_letter"), 0);
    assert.equal(await one("SELECT count(*)::int FROM events"), 0);
    await failing.close();
  });

  test("no X-Event-Id: 400, nothing to list in dead_letter", async () => {
    await resetDb();
    const res = await deliver(app, undefined, orderCreated("evt_t7", "O-T7"));
    assert.equal(res.status, 400);
    assert.equal(await one("SELECT count(*)::int FROM dead_letter"), 0);
  });

  test("a signed body replayed under another header id is refused and labelled with the real id", async () => {
    await resetDb();
    const original = (await loadDeliveries()).find((d) => d.event_id === "evt_0114")!; // the loyalty event, unknown type
    assert.deepEqual((await deliver(app, "evt_0114", original.body, { signature: original.signature })).json, { status: "unknown_type" });
    for (const id of ["evt_replay_1", "evt_replay_2"]) {
      assert.deepEqual((await deliver(app, id, original.body, { signature: original.signature })).json, { status: "dead_lettered" });
    }
    assert.equal(await one("SELECT count(*)::int FROM events WHERE outcome = 'unknown_type'"), 1);
    assert.equal(await one("SELECT count(*)::int FROM events"), 1);
    const rows = (await getPool().query("SELECT event_id, reason, detail FROM dead_letter ORDER BY event_id")).rows;
    assert.deepEqual(rows, [
      { event_id: "evt_replay_1", reason: "invalid_event", detail: "body id does not match X-Event-Id (body says evt_0114)" },
      { event_id: "evt_replay_2", reason: "invalid_event", detail: "body id does not match X-Event-Id (body says evt_0114)" },
    ]);
    // the original, delivered again under its own id, is still an ordinary duplicate
    assert.deepEqual((await deliver(app, "evt_0114", original.body, { signature: original.signature })).json, { status: "duplicate" });
  });

  test("a signed body with no id of its own is refused", async () => {
    await resetDb();
    const body = JSON.stringify({ type: "order.created", occurred_at: "2026-04-01T10:00:00Z", payload: { order_id: "O-NI", customer_email: "a@b.c", total: "1.00", currency: "EUR" } });
    assert.deepEqual((await deliver(app, "evt_ni", body)).json, { status: "dead_lettered" });
    assert.equal(await one("SELECT detail FROM dead_letter WHERE event_id = 'evt_ni'"), "body id missing");
    assert.equal(await one("SELECT count(*)::int FROM orders"), 0);
  });

  test("a header id that does not look like an id is answered 400 and never stored", async () => {
    await resetDb();
    for (const id of ["<img src=x onerror=alert(1)>", "x".repeat(65), "evt 1", "evt_1;DROP"]) {
      const signed = await deliver(app, id, orderCreated("evt_h1", "O-H1"));
      const unsigned = await deliver(app, id, orderCreated("evt_h1", "O-H1"), { signature: null });
      assert.equal(signed.status, 400, id);
      assert.equal(unsigned.status, 400, id);
      assert.equal(signed.json.error, "invalid_event_id");
    }
    assert.equal(await one("SELECT count(*)::int FROM dead_letter"), 0);
    assert.equal(await one("SELECT count(*)::int FROM events"), 0);
  });

  test("no signature, or an empty one: 401 and a bad_signature entry", async () => {
    await resetDb();
    assert.equal((await deliver(app, "evt_t8", orderCreated("evt_t8", "O-T8"), { signature: null })).status, 401);
    assert.equal((await deliver(app, "evt_t9", orderCreated("evt_t9", "O-T9"), { signature: "" })).status, 401);
    assert.equal(await one("SELECT count(*)::int FROM dead_letter WHERE reason = 'bad_signature'"), 2);
    assert.equal(await one("SELECT count(*)::int FROM orders"), 0);
  });

  test("signed but not JSON: empty body, invalid UTF-8, text. All 400 invalid_json", async () => {
    await resetDb();
    assert.equal((await deliver(app, "evt_j1", Buffer.alloc(0))).status, 400);
    assert.equal((await deliver(app, "evt_j2", Buffer.from([0x7b, 0xff, 0xfe, 0x7d]))).status, 400);
    assert.equal((await deliver(app, "evt_j3", "hello")).status, 400);
    assert.equal(await one("SELECT count(*)::int FROM dead_letter WHERE reason = 'invalid_json'"), 3);
  });

  test("a NUL character in a message is refused instead of failing the insert", async () => {
    await resetDb();
    const body = event("evt_n1", "message.received", { message_id: "M-N1", order_id: null, channel: "email", text: "hi\u0000there" });
    const res = await deliver(app, "evt_n1", body);
    assert.deepEqual(res.json, { status: "dead_lettered" });
    assert.equal(await one("SELECT detail FROM dead_letter WHERE event_id = 'evt_n1'"), "message.received: text contains a NUL character");
  });

  test("any content type works, because the signature covers the bytes", async () => {
    await resetDb();
    assert.equal((await deliver(app, "evt_c1", orderCreated("evt_c1", "O-C1"), { contentType: "text/plain" })).json.status, "accepted");
    assert.equal(await one("SELECT count(*)::int FROM orders"), 1);
  });

  test("types named like Object.prototype members are unknown types, not crashes", async () => {
    await resetDb();
    assert.equal((await deliver(app, "evt_p1", event("evt_p1", "constructor", {}))).json.status, "unknown_type");
    assert.equal((await deliver(app, "evt_p2", event("evt_p2", "__proto__", {}))).json.status, "unknown_type");
    assert.equal(await one("SELECT count(*)::int FROM events WHERE outcome = 'unknown_type'"), 2);
  });

  test("a body over 2 MiB is refused by Fastify with 413, never a crash", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks",
      headers: { "content-type": "application/json", "x-event-id": "evt_big", "x-signature": sign("x") },
      payload: Buffer.alloc(3 * 1024 * 1024, "a"),
    });
    assert.equal(res.statusCode, 413);
  });

  test("the 125 KB message in the data fits", async () => {
    await resetDb();
    const big = (await loadDeliveries()).find((d) => d.event_id === "evt_0182")!;
    assert.ok(Buffer.byteLength(big.body) > 120_000);
    const res = await injectSender(app)(big);
    assert.equal(res.status, 200);
    assert.equal(await one("SELECT length(text) > 100000 FROM messages WHERE message_id = 'M-0063'"), true);
  });
});

describe("refund decisions inside the pipeline", () => {
  const created = (id: string, orderId: string, total: string, at: string, currency = "EUR") =>
    event(id, "order.created", { order_id: orderId, customer_email: "a@example.com", total, currency }, at);
  const delivered = (id: string, orderId: string, at: string) => event(id, "shipment.delivered", { order_id: orderId }, at);
  const cancelled = (id: string, orderId: string, at: string) => event(id, "order.cancelled", { order_id: orderId }, at);
  const refundEvent = (id: string, refundId: string, orderId: string, amount: string, at: string, opts: { currency?: string; reason?: string } = {}) =>
    event(id, "refund.requested", { refund_id: refundId, order_id: orderId, amount, currency: opts.currency ?? "EUR", reason: opts.reason ?? "damaged" }, at);
  const send = (id: string, body: string) => deliver(app, id, body);
  const refundRow = async (refundId: string) =>
    (await getPool().query("SELECT decision, reason_code, decided_by, note, decided_at IS NOT NULL AS decided FROM refunds WHERE refund_id = $1", [refundId])).rows[0];
  const refunded = (orderId: string) => one<number>("SELECT refunded_minor FROM orders WHERE order_id = $1", [orderId]);

  test("a refund that arrives before its order is parked, then decided when the order arrives", async () => {
    await resetDb();
    await send("e1", delivered("e1", "O-P1", "2026-04-08T10:00:00Z"));
    await send("e2", refundEvent("e2", "R-P1", "O-P1", "10.00", "2026-04-10T10:00:00Z"));
    assert.deepEqual(await refundRow("R-P1"), { decision: "parked", reason_code: "ORDER_UNKNOWN", decided_by: "none", note: null, decided: false });

    await send("e3", created("e3", "O-P1", "50.00", "2026-04-05T10:00:00Z"));
    assert.deepEqual(await refundRow("R-P1"), { decision: "auto_approved", reason_code: "AUTO_OK", decided_by: "policy", note: null, decided: true });
    assert.equal(await refunded("O-P1"), 1000);
  });

  test("parked refunds are decided in the order they happened, not the order they arrived", async () => {
    await resetDb();
    await send("e1", delivered("e1", "O-P2", "2026-04-08T10:00:00Z"));
    // B happened later (12 April) but arrives first. Order total 30.00: A 20.00 then B 15.00 cannot both fit.
    await send("e2", refundEvent("e2", "R-P2B", "O-P2", "15.00", "2026-04-12T10:00:00Z"));
    await send("e3", refundEvent("e3", "R-P2A", "O-P2", "20.00", "2026-04-10T10:00:00Z"));
    await send("e4", created("e4", "O-P2", "30.00", "2026-04-05T10:00:00Z"));

    assert.equal((await refundRow("R-P2A")).reason_code, "AUTO_OK");
    assert.equal((await refundRow("R-P2B")).reason_code, "EXCEEDS_BALANCE");
    assert.equal(await refunded("O-P2"), 2000);
  });

  test("simultaneous refunds on one order cannot pay more than the order is worth", async () => {
    await resetDb();
    await send("e1", created("e1", "O-P3", "25.00", "2026-04-05T10:00:00Z"));
    await send("e2", delivered("e2", "O-P3", "2026-04-08T10:00:00Z"));
    const ids = ["A", "B", "C", "D"];
    await Promise.all(ids.map((x, i) => send(`r${x}`, refundEvent(`r${x}`, `R-P3${x}`, "O-P3", "10.00", `2026-04-1${i}T10:00:00Z`))));

    const rows = (await getPool().query("SELECT decision, reason_code FROM refunds ORDER BY refund_id")).rows;
    assert.equal(rows.filter((r) => r.decision === "auto_approved").length, 2);
    assert.equal(rows.filter((r) => r.reason_code === "EXCEEDS_BALANCE").length, 2);
    assert.equal(await refunded("O-P3"), 2000);
  });

  test("a refund and its late order.created at the same moment: decided once, never left parked", async () => {
    await resetDb();
    for (let i = 1; i <= 6; i++) {
      const order = `O-R${i}`;
      await send(`d${i}`, delivered(`d${i}`, order, "2026-04-08T10:00:00Z"));
      await Promise.all([
        send(`f${i}`, refundEvent(`f${i}`, `R-R${i}`, order, "10.00", "2026-04-10T10:00:00Z")),
        send(`c${i}`, created(`c${i}`, order, "50.00", "2026-04-05T10:00:00Z")),
      ]);
      assert.equal((await refundRow(`R-R${i}`)).decision, "auto_approved", `round ${i}`);
      assert.equal(await refunded(order), 1000, `round ${i}`);
    }
  });

  test("a second refund event with an existing refund_id is refused: first wins", async () => {
    await resetDb();
    await send("e1", created("e1", "O-P4", "50.00", "2026-04-05T10:00:00Z"));
    await send("e2", delivered("e2", "O-P4", "2026-04-08T10:00:00Z"));
    assert.equal((await send("e3", refundEvent("e3", "R-P4", "O-P4", "10.00", "2026-04-10T10:00:00Z"))).json.status, "accepted");
    assert.equal((await send("e4", refundEvent("e4", "R-P4", "O-P4", "40.00", "2026-04-11T10:00:00Z"))).json.status, "dead_lettered");

    assert.equal(await one("SELECT amount_minor FROM refunds WHERE refund_id = 'R-P4'"), 1000);
    assert.equal(await refunded("O-P4"), 1000);
    assert.equal(await one("SELECT detail FROM dead_letter WHERE event_id = 'e4'"), "refund already exists");
    assert.equal(await one("SELECT count(*)::int FROM events WHERE event_id = 'e4'"), 0);
  });

  test("a queued refund is not decided again when the order is delivered or cancelled later", async () => {
    await resetDb();
    await send("e1", created("e1", "O-P5", "50.00", "2026-04-05T10:00:00Z"));
    await send("e2", refundEvent("e2", "R-P5", "O-P5", "10.00", "2026-04-07T10:00:00Z", { reason: "not_received" }));
    assert.equal((await refundRow("R-P5")).reason_code, "NOT_DELIVERED");

    await send("e3", delivered("e3", "O-P5", "2026-04-08T10:00:00Z"));
    assert.deepEqual(await refundRow("R-P5"), { decision: "queued", reason_code: "NOT_DELIVERED", decided_by: "none", note: null, decided: false });
    await send("e4", cancelled("e4", "O-P5", "2026-04-09T10:00:00Z"));
    assert.equal((await refundRow("R-P5")).decision, "queued");
    assert.equal(await refunded("O-P5"), 0);
  });

  test("currencies: a mismatch goes to a human, a cancelled order still rejects, an unknown currency goes to a human", async () => {
    await resetDb();
    await send("e1", created("e1", "O-P6", "65.00", "2026-04-05T10:00:00Z", "USD"));
    await send("e2", delivered("e2", "O-P6", "2026-04-08T10:00:00Z"));
    await send("e3", refundEvent("e3", "R-P6", "O-P6", "12.00", "2026-04-11T10:00:00Z", { currency: "EUR" })); // R-0075 in miniature
    assert.deepEqual(await refundRow("R-P6"), { decision: "queued", reason_code: "OVER_THRESHOLD", decided_by: "none", note: "currency_mismatch", decided: false });

    await send("e4", cancelled("e4", "O-P6", "2026-04-12T10:00:00Z"));
    await send("e5", refundEvent("e5", "R-P6B", "O-P6", "5.00", "2026-04-13T10:00:00Z", { currency: "EUR" }));
    assert.equal((await refundRow("R-P6B")).reason_code, "ORDER_CANCELLED");

    await send("e6", created("e6", "O-P7", "10000", "2026-04-05T10:00:00Z", "JPY"));
    await send("e7", delivered("e7", "O-P7", "2026-04-08T10:00:00Z"));
    await send("e8", refundEvent("e8", "R-P7", "O-P7", "500", "2026-04-10T10:00:00Z", { currency: "JPY" }));
    assert.equal((await refundRow("R-P7")).note, "unsupported_currency");
    assert.equal(await refunded("O-P6"), 0);
    assert.equal(await refunded("O-P7"), 0);
  });

  test("one history gives one decision, whether order.created arrives on time or last (audit finding A)", async () => {
    await resetDb();
    // Timeline by occurred_at: created 04-05, delivered 04-08, refund 04-10, cancelled 04-12, second refund 04-13.
    await send("a1", created("a1", "O-ON", "50.00", "2026-04-05T10:00:00Z"));
    await send("a2", delivered("a2", "O-ON", "2026-04-08T10:00:00Z"));
    await send("a3", refundEvent("a3", "R-ON", "O-ON", "10.00", "2026-04-10T10:00:00Z"));
    await send("a4", cancelled("a4", "O-ON", "2026-04-12T10:00:00Z"));
    await send("a5", refundEvent("a5", "R-ON2", "O-ON", "10.00", "2026-04-13T10:00:00Z"));

    // The same history, but order.created arrives last, so both refunds are parked until then.
    await send("b2", delivered("b2", "O-LATE", "2026-04-08T10:00:00Z"));
    await send("b3", refundEvent("b3", "R-LATE", "O-LATE", "10.00", "2026-04-10T10:00:00Z"));
    await send("b4", cancelled("b4", "O-LATE", "2026-04-12T10:00:00Z"));
    await send("b5", refundEvent("b5", "R-LATE2", "O-LATE", "10.00", "2026-04-13T10:00:00Z"));
    assert.equal((await refundRow("R-LATE")).decision, "parked");
    await send("b1", created("b1", "O-LATE", "50.00", "2026-04-05T10:00:00Z"));

    for (const [onTime, last] of [["R-ON", "R-LATE"], ["R-ON2", "R-LATE2"]] as const) {
      const a = await refundRow(onTime);
      const b = await refundRow(last);
      assert.deepEqual({ ...b, decided: undefined }, { ...a, decided: undefined }, `${onTime} against ${last}`);
    }
    assert.equal((await refundRow("R-ON")).reason_code, "AUTO_OK"); // happened before the cancellation
    assert.equal((await refundRow("R-ON2")).reason_code, "ORDER_CANCELLED"); // happened after it
    assert.equal(await refunded("O-ON"), 1000);
    assert.equal(await refunded("O-LATE"), 1000);
  });

  test("every event that touches an order waits for that order's lock (audit finding B)", async () => {
    await resetDb();
    // Hold the lock from a second connection, as a concurrent transaction on the same order would, and check that
    // the event does not get through. Without the lock a refund could be parked just after the late order.created
    // had looked for parked refunds, and stay parked for good.
    const kinds: [string, (id: string, orderId: string) => string][] = [
      ["order.created", (id, o) => created(id, o, "50.00", "2026-04-05T10:00:00Z")],
      ["shipment.delivered", (id, o) => delivered(id, o, "2026-04-08T10:00:00Z")],
      ["order.cancelled", (id, o) => cancelled(id, o, "2026-04-12T10:00:00Z")],
      ["refund.requested", (id, o) => refundEvent(id, `R-${o}`, o, "10.00", "2026-04-10T10:00:00Z")],
    ];
    for (const [i, [name, make]] of kinds.entries()) {
      const orderId = `O-LK${i}`;
      const holder = await getPool().connect();
      let pending: Promise<unknown> | undefined;
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [orderId]);
        let finished = false;
        pending = send(`lk${i}`, make(`lk${i}`, orderId)).then((r) => {
          finished = true;
          return r;
        });
        await new Promise((resolve) => setTimeout(resolve, 1000)); // a request normally takes 100 to 600 ms
        assert.equal(finished, false, `${name} did not wait for the order's lock`);
        await holder.query("COMMIT");
        assert.equal(((await pending) as { status: number }).status, 200, name);
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        holder.release();
        await pending?.catch(() => {});
      }
    }
  });

  test("a trailing slash on the path works too", async () => {
    await resetDb();
    const res = await deliver(app, "evt_ts", orderCreated("evt_ts", "O-TS"), { url: "/webhooks/" });
    assert.deepEqual([res.status, res.json], [200, { status: "accepted" }]);
    assert.equal((await app.inject({ method: "GET", url: "/health/" })).statusCode, 200);
  });

  test("the database refuses to refund an order for more than its total, even if the code were wrong", async () => {
    await resetDb();
    await send("e1", created("e1", "O-P8", "10.00", "2026-04-05T10:00:00Z"));
    await assert.rejects(getPool().query("UPDATE orders SET refunded_minor = 1001 WHERE order_id = 'O-P8'"), (err) => (err as { code?: string }).code === "23514");
  });
});
