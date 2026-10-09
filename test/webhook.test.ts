import assert from "node:assert/strict";
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
    assert.equal(await one("SELECT total_minor FROM orders WHERE order_id = 'O-1112'"), "3730"); // 37.30 EUR, bigint comes back as text
    assert.equal(await one("SELECT count(*)::int FROM orders WHERE total_minor <= 0"), 0);
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
    assert.equal(await one("SELECT total_minor FROM orders WHERE order_id = 'O-T1'"), "1000");
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
    assert.equal(await one("SELECT total_minor FROM orders WHERE order_id = 'O-T2'"), "1000");
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
