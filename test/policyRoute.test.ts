import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildApp } from "../src/app.js";
import { policySummary } from "../src/policy.js";
import { buildQueue } from "../public/view.js";

describe("GET /policy", () => {
  const app = buildApp();

  test("tells the screen the numbers the rules use, and holds no secret", async () => {
    const res = await app.inject({ method: "GET", url: "/policy" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), policySummary());
    assert.match(String(res.headers["content-type"]), /application\/json/);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    const text = res.body.toLowerCase();
    for (const word of ["token", "secret", "password", "database", "key"]) assert.ok(!text.includes(word), word);
  });

  test("the screen's explanation of a refund over the limit names the server's limit", async () => {
    const policy = (await app.inject({ method: "GET", url: "/policy" })).json();
    const view = buildQueue(
      {
        orders: { "O-1": { status: "delivered", currency: "EUR", total_minor: 10_000, refunded_minor: 0 } },
        refunds: {
          "R-1": { order_id: "O-1", currency: "EUR", amount_minor: 2500, decision: "queued", reason_code: "OVER_THRESHOLD", decided_by: "none", reason: "damaged", note: null },
        },
      },
      policy,
    );
    assert.equal(view.groups[0]!.refunds[0]!.explanation, "The amount is over the 20.00 EUR automatic limit.");
  });
});
