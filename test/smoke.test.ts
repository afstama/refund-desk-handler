import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import Fastify from "fastify";
import { buildApp } from "../src/app.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { closePool, getPool } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { resetDb, TABLES } from "./helpers/db.js";
import { httpSender, injectSender, loadDeliveries, replay } from "./helpers/replay.js";

after(async () => {
  await closePool();
});

const goodEnv = {
  DATABASE_URL: "postgresql://user:pw@host/db",
  WEBHOOK_SECRET: "s",
  APPROVER_TOKEN: "t",
  ANTHROPIC_API_KEY: "k",
};

describe("config", () => {
  test("accepts a complete environment and defaults the port", () => {
    assert.equal(loadConfig(goodEnv).PORT, 3000);
  });

  test("a missing key is named, and no value appears in the message", () => {
    assert.throws(
      () => loadConfig({ DATABASE_URL: "postgresql://user:TOPSECRETPW@host/db" }),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.deepEqual(err.keys, ["WEBHOOK_SECRET", "APPROVER_TOKEN", "ANTHROPIC_API_KEY"]);
        assert.ok(!err.message.includes("TOPSECRETPW"));
        return true;
      },
    );
  });

  test("an invalid value is named, and the value is not echoed", () => {
    assert.throws(
      () => loadConfig({ ...goodEnv, DATABASE_URL: "TOPSECRETPW" }),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.deepEqual(err.keys, ["DATABASE_URL"]);
        assert.ok(!err.message.includes("TOPSECRETPW"));
        return true;
      },
    );
  });
});

describe("database", () => {
  test("migrations are idempotent and create every table", async () => {
    await migrate();
    assert.deepEqual(await migrate(), []);
    for (const table of TABLES) {
      const res = await getPool().query("SELECT to_regclass($1::text) AS found", [`public.${table}`]);
      assert.ok(res.rows[0].found, `table ${table} is missing`);
    }
  });

  test("resetDb empties the tables", async () => {
    await resetDb();
    await getPool().query("INSERT INTO events (event_id, body_sha256, body, type, outcome) VALUES ('evt_x', 'h', '{}', 't', 'applied')");
    await resetDb();
    const res = await getPool().query("SELECT count(*)::int AS n FROM events");
    assert.equal(res.rows[0].n, 0);
  });

  test("resetDb refuses when NODE_ENV=production", async () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await assert.rejects(resetDb(), /refused/);
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
    }
  });

  test("the schema refuses states the policy must never reach", async () => {
    await resetDb();
    const pool = getPool();
    const code = (expected: string) => (err: unknown) => (err as { code?: string }).code === expected;
    await pool.query("INSERT INTO events (event_id, body_sha256, body, type, outcome) VALUES ('evt_1', 'h', '{}', 't', 'applied')");

    // an order can never be refunded for more than its total
    await assert.rejects(
      pool.query("INSERT INTO orders (order_id, currency, total_minor, refunded_minor, created_at, event_id) VALUES ('O-1', 'EUR', 1000, 1001, now(), 'evt_1')"),
      code("23514"),
    );

    const refund = (id: string, decision: string, decidedBy: string) =>
      pool.query(
        `INSERT INTO refunds (refund_id, order_id, currency, amount_minor, reason, occurred_at, decision, reason_code, decided_by, event_id)
         VALUES ($1, 'O-1', 'EUR', 100, 'damaged', now(), $2, 'AUTO_OK', $3, 'evt_1')`,
        [id, decision, decidedBy],
      );
    await refund("R-1", "queued", "none");
    await refund("R-2", "auto_approved", "policy");
    await assert.rejects(refund("R-3", "queued", "policy"), code("23514"));
    await assert.rejects(refund("R-4", "approved", "none"), code("23514"));
    await assert.rejects(refund("R-5", "maybe", "policy"), code("23514"));
    // a refund is stored once
    await assert.rejects(refund("R-1", "queued", "none"), code("23505"));

    // dead_letter: once per event per reason
    const dead = "INSERT INTO dead_letter (event_id, reason) VALUES ('evt_9', 'bad_signature') ON CONFLICT DO NOTHING";
    assert.equal((await pool.query(dead)).rowCount, 1);
    assert.equal((await pool.query(dead)).rowCount, 0);
    await resetDb();
  });
});

describe("app", () => {
  test("GET /health reports the database", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, db: true });
    await app.close();
  });
});

describe("replay helper", () => {
  test("events.ndjson has 421 deliveries and 416 unique ids", async () => {
    const deliveries = await loadDeliveries();
    assert.equal(deliveries.length, 421);
    assert.equal(new Set(deliveries.map((d) => d.event_id)).size, 416);
    for (const d of deliveries) {
      assert.equal(typeof d.event_id, "string");
      assert.equal(typeof d.signature, "string");
      assert.equal(typeof d.body, "string");
    }
  });

  test("both senders pass id, signature and the exact body to /webhooks", async () => {
    const deliveries = await loadDeliveries();
    const seen: { id?: string; sig?: string; body: string }[] = [];
    const echo = Fastify();
    echo.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
    echo.post("/webhooks", async (req) => {
      seen.push({ id: req.headers["x-event-id"] as string, sig: req.headers["x-signature"] as string, body: req.body as string });
      return { ok: true };
    });
    await echo.listen({ port: 0, host: "127.0.0.1" });
    const address = echo.server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const viaInject = await replay(injectSender(echo), deliveries, { limit: 3 });
    const viaHttp = await replay(httpSender(`http://127.0.0.1:${port}`), deliveries, { limit: 3 });
    await echo.close();

    assert.deepEqual(viaInject.map((r) => r.status), [200, 200, 200]);
    assert.deepEqual(viaHttp.map((r) => r.status), [200, 200, 200]);
    assert.equal(seen.length, 6);
    seen.forEach((s, i) => {
      const d = deliveries[i % 3]!;
      assert.deepEqual(s, { id: d.event_id, sig: d.signature, body: d.body });
    });
  });

  test("httpSender reports no answer as status 0", async () => {
    const [result] = await replay(httpSender("http://127.0.0.1:1", 500), await loadDeliveries(), { limit: 1 });
    assert.equal(result!.status, 0);
    assert.ok(result!.error);
  });
});
