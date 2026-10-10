import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { buildApp } from "../src/app.js";
import { SAME_ORIGIN_HEADER, SAME_ORIGIN_VALUE } from "../src/auth.js";
import { getConfig } from "../src/config.js";
import { closePool, getPool } from "../src/db.js";
import { cookieName, issueSession, SESSION_SECONDS } from "../src/session.js";
import { resetDb } from "./helpers/db.js";
import { deliver, event } from "./helpers/webhook.js";

const app = buildApp();
const token = () => getConfig().APPROVER_TOKEN;
const sameOrigin = { [SAME_ORIGIN_HEADER]: SAME_ORIGIN_VALUE };

after(async () => {
  await app.close();
  await closePool();
});

type Res = Awaited<ReturnType<typeof app.inject>>;
const login = (payload: string | undefined, headers: Record<string, string> = { "content-type": "application/json" }) =>
  app.inject({ method: "POST", url: "/login", headers, payload });
const goodLogin = () => login(JSON.stringify({ token: token() }));
/** "name=value" of the cookie a response sets, ready to send back. */
const cookieOf = (res: Res) => String(res.headers["set-cookie"]).split(";")[0]!;
const setCookie = (res: Res) => String(res.headers["set-cookie"] ?? "");

// A small world: O-Q is 60.00 with two queued 35.00 refunds, O-A has an auto-approved one, O-P a parked refund.
const created = (id: string, o: string, total: string) => event(id, "order.created", { order_id: o, customer_email: "a@example.com", total, currency: "EUR" }, "2026-04-05T10:00:00Z");
const delivered = (id: string, o: string) => event(id, "shipment.delivered", { order_id: o }, "2026-04-08T10:00:00Z");
const refundEvent = (id: string, r: string, o: string, amount: string, at = "2026-04-10T10:00:00Z") =>
  event(id, "refund.requested", { refund_id: r, order_id: o, amount, currency: "EUR", reason: "damaged" }, at);
async function seed() {
  await resetDb();
  const send = (id: string, body: string) => deliver(app, id, body);
  await send("q1", created("q1", "O-Q", "60.00"));
  await send("q2", delivered("q2", "O-Q"));
  await send("q3", refundEvent("q3", "R-QA", "O-Q", "35.00"));
  await send("q4", refundEvent("q4", "R-QB", "O-Q", "35.00", "2026-04-11T10:00:00Z"));
  await send("a1", created("a1", "O-A", "50.00"));
  await send("a2", delivered("a2", "O-A"));
  await send("a3", refundEvent("a3", "R-AUTO", "O-A", "10.00"));
  await send("p1", refundEvent("p1", "R-PARKED", "O-NOT-YET", "5.00"));
}
const decisionOf = async (id: string) => (await getPool().query("SELECT decision FROM refunds WHERE refund_id = $1", [id])).rows[0]?.decision as string;

describe("POST /login", () => {
  test("a wrong token is 401 and sets no cookie", async () => {
    const res = await login(JSON.stringify({ token: "not-the-token" }));
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: "unauthorized" });
    assert.equal(res.headers["set-cookie"], undefined);
  });

  test("every way of failing gives exactly the same answer (nothing for a guesser to learn)", async () => {
    const attempts: [string, string | undefined, Record<string, string>?][] = [
      ["wrong token", JSON.stringify({ token: "nope" })],
      ["empty token", JSON.stringify({ token: "" })],
      ["token of the wrong type", JSON.stringify({ token: 12345 })],
      ["token almost right", JSON.stringify({ token: token() + " " })],
      ["no token field", JSON.stringify({})],
      ["not JSON", "this is not json"],
      ["empty body", undefined],
      ["a list", JSON.stringify([token()])],
      ["a very long token", JSON.stringify({ token: "x".repeat(900) })],
      ["another content type", JSON.stringify({ token: "nope" }), { "content-type": "text/plain" }],
    ];
    const answers = await Promise.all(attempts.map(([, body, headers]) => login(body, headers)));
    const first = answers[0]!;
    answers.forEach((res, i) => {
      assert.equal(res.statusCode, 401, attempts[i]![0]);
      assert.equal(res.body, first.body, attempts[i]![0]);
      assert.equal(res.headers["content-type"], first.headers["content-type"], attempts[i]![0]);
      assert.equal(res.headers["set-cookie"], undefined, attempts[i]![0]);
    });
  });

  test("the right token is 204 with an HttpOnly, SameSite=Strict session cookie that does not hold the token", async () => {
    const res = await goodLogin();
    assert.equal(res.statusCode, 204);
    assert.equal(res.body, "");
    const header = setCookie(res);
    assert.ok(header.startsWith("refund_desk_session=v1."), header.slice(0, 40));
    for (const part of ["Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${SESSION_SECONDS}`]) assert.ok(header.includes(part), part);
    assert.ok(!header.includes("Secure"), "over plain http in development the cookie is not Secure");
    assert.ok(!header.includes(token()), "the token is not in the cookie");
    assert.equal(res.headers["cache-control"], "no-store");
  });

  test("in production the cookie is Secure and carries the __Host- prefix, and only that name is accepted", async () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await goodLogin();
      const header = setCookie(res);
      assert.ok(header.startsWith("__Host-refund_desk_session=v1."), header.slice(0, 40));
      assert.ok(header.includes("Secure") && header.includes("HttpOnly") && header.includes("SameSite=Strict"));
      assert.ok(!header.includes("Domain"));
      const ok = await app.inject({ method: "GET", url: "/queue", headers: { cookie: cookieOf(res), ...sameOrigin } });
      assert.equal(ok.statusCode, 200);
      const plainName = `refund_desk_session=${issueSession(token()).value}`;
      const refused = await app.inject({ method: "GET", url: "/queue", headers: { cookie: plainName, ...sameOrigin } });
      assert.equal(refused.statusCode, 401);
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
    }
  });

  test("the cookie is not usable with another token's signing key", async () => {
    const foreign = `${cookieName(false)}=${issueSession("some-other-token").value}`;
    const res = await app.inject({ method: "GET", url: "/queue", headers: { cookie: foreign, ...sameOrigin } });
    assert.equal(res.statusCode, 401);
  });
});

describe("GET /queue is private", () => {
  test("no credentials: 401, with no cache and no detail", async () => {
    await seed();
    const res = await app.inject({ method: "GET", url: "/queue" });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: "unauthorized" });
    assert.equal(res.headers["cache-control"], "no-store");
  });

  test("a session cookie needs the same-origin header; the Bearer header needs nothing else", async () => {
    await seed();
    const cookie = cookieOf(await goodLogin());
    assert.equal((await app.inject({ method: "GET", url: "/queue", headers: { cookie } })).statusCode, 401, "cookie alone");
    assert.equal((await app.inject({ method: "GET", url: "/queue", headers: { cookie, ...sameOrigin } })).statusCode, 200, "cookie and header");
    assert.equal((await app.inject({ method: "GET", url: "/queue", headers: { authorization: `Bearer ${token()}` } })).statusCode, 200, "bearer");
    assert.equal((await app.inject({ method: "GET", url: "/queue", headers: { authorization: "Bearer wrong" } })).statusCode, 401, "wrong bearer");
  });

  test("an expired session is refused", async () => {
    await seed();
    const old = issueSession(token(), Date.now() - (SESSION_SECONDS + 60) * 1000).value;
    const res = await app.inject({ method: "GET", url: "/queue", headers: { cookie: `${cookieName(false)}=${old}`, ...sameOrigin } });
    assert.equal(res.statusCode, 401);
  });

  test("holds only the queued refunds and their orders, in the ledger's shape, and no email", async () => {
    await seed();
    const res = await app.inject({ method: "GET", url: "/queue", headers: { authorization: `Bearer ${token()}` } });
    const body = res.json() as { orders: Record<string, { status: string; total_minor: number; refunded_minor: number }>; refunds: Record<string, { decision: string; order_id: string }> };
    assert.deepEqual(Object.keys(body.refunds), ["R-QA", "R-QB"]);
    assert.ok(Object.values(body.refunds).every((r) => r.decision === "queued"));
    assert.deepEqual(Object.keys(body.orders), ["O-Q"]);
    assert.deepEqual(body.orders["O-Q"], { status: "delivered", currency: "EUR", total_minor: 6000, refunded_minor: 0, total_eur_minor: 6000, refunded_eur_minor: 0, remaining_eur_minor: 6000 });
    assert.ok(!res.body.includes("@"));
    assert.equal(res.headers["cache-control"], "no-store");
  });

  test("503 when the database cannot be read, and the credentials are still checked first", async () => {
    const failing = buildApp({ readQueue: async () => { throw new Error("db down"); } });
    assert.equal((await failing.inject({ method: "GET", url: "/queue" })).statusCode, 401);
    assert.equal((await failing.inject({ method: "GET", url: "/queue", headers: { authorization: `Bearer ${token()}` } })).statusCode, 503);
    await failing.close();
  });
});

describe("approve and reject with a session", () => {
  test("a session approves, with the same-origin header; without it nothing happens", async () => {
    await seed();
    const cookie = cookieOf(await goodLogin());
    const noHeader = await app.inject({ method: "POST", url: "/refunds/R-QA/approve", headers: { cookie } });
    assert.equal(noHeader.statusCode, 401);
    assert.equal(await decisionOf("R-QA"), "queued", "a cookie alone changed nothing (cross-site request protection)");

    const ok = await app.inject({ method: "POST", url: "/refunds/R-QA/approve", headers: { cookie, ...sameOrigin } });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().refund.decided_by, "human");
    assert.equal(await decisionOf("R-QA"), "approved");
  });

  test("the Bearer header still works exactly as the contract has it", async () => {
    await seed();
    const ok = await app.inject({ method: "POST", url: "/refunds/R-QB/reject", headers: { authorization: `Bearer ${token()}` } });
    assert.equal(ok.statusCode, 200);
    assert.equal(await decisionOf("R-QB"), "rejected");
  });

  test("a forged cookie, an expired one and a cookie from another key all do nothing", async () => {
    await seed();
    const forged = `${cookieName(false)}=v1.9999999999.${"A".repeat(43)}`;
    const old = `${cookieName(false)}=${issueSession(token(), Date.now() - (SESSION_SECONDS + 60) * 1000).value}`;
    const foreign = `${cookieName(false)}=${issueSession("another-token").value}`;
    for (const cookie of [forged, old, foreign]) {
      const res = await app.inject({ method: "POST", url: "/refunds/R-QA/approve", headers: { cookie, ...sameOrigin } });
      assert.equal(res.statusCode, 401);
    }
    assert.equal(await decisionOf("R-QA"), "queued");
  });

  test("unknown ids stay 401 without credentials and 404 with them: ids cannot be probed", async () => {
    await seed();
    assert.equal((await app.inject({ method: "POST", url: "/refunds/R-NOPE/approve" })).statusCode, 401);
    const cookie = cookieOf(await goodLogin());
    assert.equal((await app.inject({ method: "POST", url: "/refunds/R-NOPE/approve", headers: { cookie, ...sameOrigin } })).statusCode, 404);
  });
});

describe("POST /logout", () => {
  test("clears the cookie, and a cleared cookie is no session", async () => {
    const res = await app.inject({ method: "POST", url: "/logout", headers: sameOrigin });
    assert.equal(res.statusCode, 204);
    const header = setCookie(res);
    assert.ok(header.startsWith("refund_desk_session=;"), header);
    assert.ok(header.includes("Max-Age=0"));
    const afterwards = await app.inject({ method: "GET", url: "/queue", headers: { cookie: cookieOf(res), ...sameOrigin } });
    assert.equal(afterwards.statusCode, 401);
  });
});

describe("what stays public", () => {
  test("the page and its files, the policy, the ledger, health need no login", async () => {
    for (const url of ["/", "/app.js", "/view.js", "/app.css", "/policy", "/ledger", "/health"]) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 200, url);
    }
  });

  test("no CORS headers are ever sent: another site cannot read answers or add the same-origin header", async () => {
    const res = await app.inject({ method: "OPTIONS", url: "/refunds/R-1/approve", headers: { origin: "https://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "x-requested-with" } });
    for (const name of Object.keys(res.headers)) assert.ok(!name.startsWith("access-control-"), name);
    const get = await app.inject({ method: "GET", url: "/ledger", headers: { origin: "https://evil.example" } });
    for (const name of Object.keys(get.headers)) assert.ok(!name.startsWith("access-control-"), name);
  });
});
