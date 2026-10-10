import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { buildApp } from "../src/app.js";
import { bearerToken, tokenMatches } from "../src/auth.js";
import { getConfig } from "../src/config.js";
import { closePool, getPool } from "../src/db.js";
import type { Ledger } from "../src/ledger.js";
import { resetDb } from "./helpers/db.js";
import { deliver, event } from "./helpers/webhook.js";

const app = buildApp();
const token = () => getConfig().APPROVER_TOKEN;

after(async () => {
  await app.close();
  await closePool();
});

// --- helpers: build a small world through the real webhook pipeline ---
const created = (id: string, orderId: string, total: string, currency = "EUR") =>
  event(id, "order.created", { order_id: orderId, customer_email: "a@example.com", total, currency }, "2026-04-05T10:00:00Z");
const delivered = (id: string, orderId: string) => event(id, "shipment.delivered", { order_id: orderId }, "2026-04-08T10:00:00Z");
const cancelled = (id: string, orderId: string) => event(id, "order.cancelled", { order_id: orderId }, "2026-04-20T10:00:00Z");
const refundEvent = (id: string, refundId: string, orderId: string, amount: string, opts: { currency?: string; reason?: string; at?: string } = {}) =>
  event(id, "refund.requested", { refund_id: refundId, order_id: orderId, amount, currency: opts.currency ?? "EUR", reason: opts.reason ?? "damaged" }, opts.at ?? "2026-04-10T10:00:00Z");
const send = (id: string, body: string) => deliver(app, id, body);

interface Reply { status: number; json: any }
async function act(action: "approve" | "reject", refundId: string, headers: Record<string, string> | null = undefined as never): Promise<Reply> {
  const h = headers === (undefined as never) ? { authorization: `Bearer ${token()}` } : (headers ?? {});
  const res = await app.inject({ method: "POST", url: `/refunds/${encodeURIComponent(refundId)}/${action}`, headers: h });
  return { status: res.statusCode, json: res.json() };
}
const approve = (id: string, headers?: Record<string, string> | null) => act("approve", id, headers);
const reject = (id: string, headers?: Record<string, string> | null) => act("reject", id, headers);

async function one<T = number>(sql: string, params: unknown[] = []): Promise<T> {
  return Object.values((await getPool().query(sql, params)).rows[0])[0] as T;
}
const refunded = (orderId: string) => one<number>("SELECT refunded_minor FROM orders WHERE order_id = $1", [orderId]);
const refundRow = async (id: string) =>
  (await getPool().query("SELECT decision, reason_code, decided_by, note, decided_at IS NOT NULL AS decided FROM refunds WHERE refund_id = $1", [id])).rows[0];

/** An order of 60.00 with two queued refunds of 35.00 each: O-1122 in miniature. */
async function twoBigRefunds(prefix: string) {
  await send(`${prefix}1`, created(`${prefix}1`, `O-${prefix}`, "60.00"));
  await send(`${prefix}2`, delivered(`${prefix}2`, `O-${prefix}`));
  await send(`${prefix}3`, refundEvent(`${prefix}3`, `R-${prefix}A`, `O-${prefix}`, "35.00"));
  await send(`${prefix}4`, refundEvent(`${prefix}4`, `R-${prefix}B`, `O-${prefix}`, "35.00", { at: "2026-04-11T10:00:00Z" }));
}

describe("auth helpers (no database)", () => {
  test("bearerToken reads the token, scheme case-insensitive", () => {
    assert.equal(bearerToken("Bearer abc123"), "abc123");
    assert.equal(bearerToken("bearer abc123"), "abc123");
    assert.equal(bearerToken("BEARER   abc123  "), "abc123");
  });

  test("bearerToken refuses anything else", () => {
    for (const h of [undefined, "", "Bearer", "Bearer ", "Basic abc", "abc123", "Bearer a b", "Token abc"]) assert.equal(bearerToken(h), null, String(h));
  });

  test("tokenMatches is exact", () => {
    assert.equal(tokenMatches("s3cret-token", "s3cret-token"), true);
    for (const wrong of ["s3cret-toke", "s3cret-token ", "S3CRET-TOKEN", "", "x".repeat(500)]) assert.equal(tokenMatches("s3cret-token", wrong), false, wrong);
    assert.equal(tokenMatches("s3cret-token", null), false);
  });
});

describe("POST /refunds/:id/approve and /reject", () => {
  test("401 for a missing, wrong or malformed token, and the refund is untouched", async () => {
    await resetDb();
    await twoBigRefunds("A");
    for (const headers of [null, { authorization: "Bearer wrong-token" }, { authorization: "Basic abc" }, { authorization: "Bearer " }, { authorization: token() }]) {
      for (const action of [approve, reject]) {
        const r = await action("R-AA", headers as Record<string, string> | null);
        assert.equal(r.status, 401, JSON.stringify(headers));
        assert.deepEqual(r.json, { error: "unauthorized" });
      }
    }
    assert.deepEqual(await refundRow("R-AA"), { decision: "queued", reason_code: "OVER_THRESHOLD", decided_by: "none", note: null, decided: false });
    assert.equal(await refunded("O-A"), 0);
  });

  test("the token is checked before the id: an unknown id is 401 without it, 404 with it", async () => {
    await resetDb();
    assert.equal((await approve("R-NOPE", { authorization: "Bearer wrong" })).status, 401);
    assert.equal((await approve("R-NOPE")).status, 404);
    assert.deepEqual((await reject("R-NOPE")).json, { error: "unknown_refund" });
    assert.equal((await approve("%3Cscript%3E")).status, 404);
    assert.equal((await approve("x".repeat(100))).status, 404); // the longest id that can exist
    assert.equal((await approve("x".repeat(101))).status, 414); // Fastify refuses a longer parameter before our code runs
  });

  test("approve: 200, the refund becomes approved by a human and the order's balance moves", async () => {
    await resetDb();
    await twoBigRefunds("B");
    const r = await approve("R-BA");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.refund, {
      refund_id: "R-BA",
      order_id: "O-B",
      currency: "EUR",
      amount_minor: 3500,
      decision: "approved",
      reason_code: "HUMAN_APPROVED",
      decided_by: "human",
      reason: "damaged",
      note: null,
    });
    assert.deepEqual(r.json.order, { order_id: "O-B", total_minor: 6000, refunded_minor: 3500, remaining_minor: 2500 });
    assert.equal(await refunded("O-B"), 3500);
    assert.equal((await refundRow("R-BA")).decided, true);

    // and the ledger says the same
    const ledger = (await app.inject({ method: "GET", url: "/ledger" })).json() as Ledger;
    assert.equal(ledger.refunds["R-BA"]!.decision, "approved");
    assert.equal(ledger.refunds["R-BA"]!.decided_by, "human");
    assert.equal(ledger.orders["O-B"]!.refunded_minor, 3500);
  });

  test("reject: 200, rejected by a human, the balance does not move", async () => {
    await resetDb();
    await twoBigRefunds("C");
    const r = await reject("R-CA");
    assert.equal(r.status, 200);
    assert.equal(r.json.refund.decision, "rejected");
    assert.equal(r.json.refund.reason_code, "HUMAN_REJECTED");
    assert.equal(r.json.refund.decided_by, "human");
    assert.equal(await refunded("O-C"), 0);
  });

  test("the same person clicking twice is paid once: the second click is 409 already_decided", async () => {
    await resetDb();
    await twoBigRefunds("D");
    assert.equal((await approve("R-DA")).status, 200);
    const again = await approve("R-DA");
    assert.equal(again.status, 409);
    assert.equal(again.json.error, "already_decided");
    assert.deepEqual(again.json.refund, { decision: "approved", reason_code: "HUMAN_APPROVED", decided_by: "human" });
    assert.equal((await reject("R-DA")).json.error, "already_decided"); // a decision is final
    assert.equal(await refunded("O-D"), 3500);
  });

  test("a refund that no longer fits stays queued with 409 exceeds_balance (POLICY.md section 7), and can still be rejected", async () => {
    await resetDb();
    await twoBigRefunds("E"); // 60.00 order, 35.00 + 35.00 (O-1122 in miniature)
    assert.equal((await approve("R-EA")).status, 200);
    const second = await approve("R-EB");
    assert.equal(second.status, 409);
    assert.equal(second.json.error, "exceeds_balance");
    assert.equal(second.json.remaining_minor, 2500);
    assert.equal((await refundRow("R-EB")).decision, "queued");
    assert.equal(await refunded("O-E"), 3500);

    const rejected = await reject("R-EB");
    assert.equal(rejected.status, 200);
    assert.equal(rejected.json.refund.reason_code, "HUMAN_REJECTED");
  });

  test("auto-approved and policy-rejected refunds are already decided", async () => {
    await resetDb();
    await send("f1", created("f1", "O-F", "50.00"));
    await send("f2", delivered("f2", "O-F"));
    await send("f3", refundEvent("f3", "R-FAUTO", "O-F", "10.00")); // AUTO_OK
    await send("f4", refundEvent("f4", "R-FREJ", "O-F", "90.00")); // EXCEEDS_BALANCE
    assert.equal((await approve("R-FAUTO")).json.error, "already_decided");
    assert.equal((await approve("R-FREJ")).json.error, "already_decided");
    assert.equal((await reject("R-FAUTO")).json.error, "already_decided");
    assert.equal(await refunded("O-F"), 1000);
  });

  test("a parked refund is not in the queue: 409 not_queued for approve and reject (POLICY.md sections 5 and 7)", async () => {
    await resetDb();
    await send("p1", refundEvent("p1", "R-PARK", "O-NOT-YET", "5.00"));
    for (const action of [approve, reject]) {
      const r = await action("R-PARK");
      assert.equal(r.status, 409);
      assert.equal(r.json.error, "not_queued");
      assert.equal(r.json.refund.decision, "parked");
    }
    assert.equal((await refundRow("R-PARK")).decision, "parked");
  });

  test("an order cancelled after the refund was queued: approve is 409 order_cancelled, reject still works, nothing is removed", async () => {
    await resetDb();
    await send("g1", created("g1", "O-G", "50.00"));
    await send("g2", refundEvent("g2", "R-G", "O-G", "10.00", { reason: "not_received" })); // NOT_DELIVERED, queued
    assert.equal((await refundRow("R-G")).reason_code, "NOT_DELIVERED");
    await send("g3", cancelled("g3", "O-G"));
    assert.equal((await refundRow("R-G")).decision, "queued"); // the cancellation does not touch it

    const a = await approve("R-G");
    assert.equal(a.status, 409);
    assert.equal(a.json.error, "order_cancelled");
    assert.equal(await refunded("O-G"), 0);
    assert.equal((await reject("R-G")).status, 200);
  });

  test("a refund in another currency than its order cannot be approved yet (R-0075): 409 currency_mismatch, reject works", async () => {
    await resetDb();
    await send("h1", created("h1", "O-H", "65.00", "USD"));
    await send("h2", delivered("h2", "O-H"));
    await send("h3", refundEvent("h3", "R-H", "O-H", "12.00", { currency: "EUR" }));
    assert.equal((await refundRow("R-H")).note, "currency_mismatch");
    const a = await approve("R-H");
    assert.equal(a.status, 409);
    assert.equal(a.json.error, "currency_mismatch");
    assert.equal(await refunded("O-H"), 0);
    assert.equal((await reject("R-H")).status, 200);
  });

  test("a queued refund on an order that was never delivered may be approved (POLICY.md section 4 and 7)", async () => {
    await resetDb();
    await send("i1", created("i1", "O-I", "50.00"));
    await send("i2", refundEvent("i2", "R-I", "O-I", "10.00", { reason: "not_received" }));
    assert.equal((await refundRow("R-I")).reason_code, "NOT_DELIVERED");
    assert.equal((await approve("R-I")).status, 200);
    assert.equal(await refunded("O-I"), 1000);
  });

  test("any body is accepted: empty with a JSON content type, JSON, text; over 1 KiB is 413", async () => {
    await resetDb();
    await send("j1", created("j1", "O-J", "500.00"));
    await send("j2", delivered("j2", "O-J"));
    for (const n of [1, 2, 3, 4]) await send(`j${n + 2}`, refundEvent(`j${n + 2}`, `R-J${n}`, "O-J", "30.00"));
    const auth = { authorization: `Bearer ${token()}` };
    const post = (id: string, headers: Record<string, string>, payload?: string | Buffer) =>
      app.inject({ method: "POST", url: `/refunds/${id}/approve`, headers: { ...auth, ...headers }, payload });
    assert.equal((await post("R-J1", { "content-type": "application/json" })).statusCode, 200);
    assert.equal((await post("R-J2", { "content-type": "application/json" }, "{}")).statusCode, 200);
    assert.equal((await post("R-J3", { "content-type": "text/plain" }, "hello")).statusCode, 200);
    assert.equal((await post("R-J4", { "content-type": "application/json" }, Buffer.alloc(2048, "a"))).statusCode, 413);
    assert.equal((await refundRow("R-J4")).decision, "queued");
  });

  test("the answer is 503 when the database cannot be read, and the token is still checked first", async () => {
    const failing = buildApp({ decide: async () => { throw new Error("db down"); } });
    const auth = { authorization: `Bearer ${token()}` };
    assert.equal((await failing.inject({ method: "POST", url: "/refunds/R-X/approve", headers: auth })).statusCode, 503);
    assert.equal((await failing.inject({ method: "POST", url: "/refunds/R-X/approve" })).statusCode, 401);
    await failing.close();
  });
});

describe("never paid twice, under simultaneous requests", () => {
  test("one refund approved four times at once: one 200, three 409, paid once", async () => {
    await resetDb();
    await twoBigRefunds("K");
    const results = await Promise.all([1, 2, 3, 4].map(() => approve("R-KA")));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409, 409]);
    assert.ok(results.filter((r) => r.status === 409).every((r) => r.json.error === "already_decided"));
    assert.equal(await refunded("O-K"), 3500);
  });

  test("two refunds that do not both fit, approved at once (O-1122): exactly one wins", async () => {
    await resetDb();
    await twoBigRefunds("L");
    const [a, b] = await Promise.all([approve("R-LA"), approve("R-LB")]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const loser = a.status === 409 ? a : b;
    assert.equal(loser.json.error, "exceeds_balance");
    assert.equal(await refunded("O-L"), 3500);
    assert.equal(await one("SELECT count(*)::int FROM refunds WHERE order_id = 'O-L' AND decision = 'approved'"), 1);
  });

  test("approve and reject of the same refund at once: exactly one of them wins", async () => {
    await resetDb();
    await twoBigRefunds("M");
    const [a, r] = await Promise.all([approve("R-MA"), reject("R-MA")]);
    assert.deepEqual([a.status, r.status].sort(), [200, 409]);
    const row = await refundRow("R-MA");
    assert.equal(row.decision, a.status === 200 ? "approved" : "rejected");
    assert.equal(await refunded("O-M"), a.status === 200 ? 3500 : 0);
  });

  test("a human approval and an incoming refund event on the same order cannot overpay it", async () => {
    await resetDb();
    for (let i = 1; i <= 4; i++) {
      const order = `O-N${i}`;
      await send(`n${i}a`, created(`n${i}a`, order, "25.00"));
      await send(`n${i}b`, delivered(`n${i}b`, order));
      // queued (reason not eligible): 15.00 of the 25.00
      await send(`n${i}c`, refundEvent(`n${i}c`, `R-N${i}Q`, order, "15.00", { reason: "changed_mind" }));
      assert.equal((await refundRow(`R-N${i}Q`)).reason_code, "REASON_NOT_ELIGIBLE");
      // at the same moment: a human approves it and an auto-approvable 15.00 refund arrives. Both cannot fit.
      const [h] = await Promise.all([approve(`R-N${i}Q`), send(`n${i}d`, refundEvent(`n${i}d`, `R-N${i}W`, order, "15.00", { at: "2026-04-11T10:00:00Z" }))]);
      assert.equal(await refunded(order), 1500, `round ${i}`);
      const approvedCount = await one("SELECT count(*)::int FROM refunds WHERE order_id = $1 AND decision IN ('approved', 'auto_approved')", [order]);
      assert.equal(approvedCount, 1, `round ${i}: ${h.status}`);
    }
  });

  test("an approval and a cancellation at the same moment: one after the other, never both half-way", async () => {
    await resetDb();
    for (let i = 1; i <= 4; i++) {
      const order = `O-X${i}`;
      await send(`x${i}a`, created(`x${i}a`, order, "50.00"));
      await send(`x${i}b`, refundEvent(`x${i}b`, `R-X${i}`, order, "10.00", { reason: "not_received" })); // queued, not delivered
      const [a] = await Promise.all([approve(`R-X${i}`), send(`x${i}c`, cancelled(`x${i}c`, order))]);
      const row = await refundRow(`R-X${i}`);
      if (a.status === 200) assert.equal(row.decision, "approved", `round ${i}`);
      else assert.deepEqual([a.json.error, row.decision], ["order_cancelled", "queued"], `round ${i}`);
      assert.equal(await refunded(order), a.status === 200 ? 1000 : 0, `round ${i}`);
    }
  });

  test("a decision waits for the order's lock (the same lock the webhook pipeline takes)", async () => {
    await resetDb();
    await twoBigRefunds("W");
    const holder = await getPool().connect();
    let pending: Promise<Reply> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["O-W"]);
      let finished = false;
      pending = approve("R-WA").then((r) => {
        finished = true;
        return r;
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.equal(finished, false, "the approval did not wait for the order's lock");
      await holder.query("COMMIT");
      assert.equal((await pending).status, 200);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
      await pending?.catch(() => {});
    }
  });
});
