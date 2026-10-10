// POST /outbound with the real database: who may call it, what it refuses, and that a message is answered once.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { buildApp } from "../src/app.js";
import { getConfig } from "../src/config.js";
import { closePool, getPool } from "../src/db.js";
import { OUTBOUND_SIGNATURE_HEADER, signOutbound } from "../src/triage/outboundAuth.js";
import { resetDb } from "./helpers/db.js";
import { deliver, event, sign } from "./helpers/webhook.js";

const app = buildApp();
const secret = () => getConfig().WEBHOOK_SECRET;

before(async () => {
  await resetDb();
});
after(async () => {
  await resetDb();
  await app.close();
  await closePool();
});

let n = 0;
/** Stores a message through the real webhook, then writes a triage result into its row. */
async function message(opts: { category?: string; flags?: string[]; truncated?: boolean; held?: string | null; draft?: string; status?: "pending" | "done" } = {}) {
  const id = `M-${String(++n).padStart(4, "0")}`;
  const res = await deliver(app, `evt_msg_${id}`, event(`evt_msg_${id}`, "message.received", { message_id: id, order_id: null, channel: "email", text: "hello" }));
  assert.equal(res.json.status, "accepted");
  if ((opts.status ?? "done") === "done") {
    await getPool().query(
      `UPDATE messages SET triage_status = 'done', category = $2, sentiment = 'neutral', draft_reply = $3, flags = $4::text[],
              truncated = $5, held_reason = $6, model = 'claude-haiku-5-5', triaged_at = now() WHERE message_id = $1`,
      [id, opts.category ?? "product_question", opts.draft ?? "Thanks, our team will check.", opts.flags ?? [], opts.truncated ?? false, opts.held ?? null],
    );
  }
  return id;
}

interface Reply {
  status: number;
  json: Record<string, unknown>;
}
async function post(body: unknown, signature: string | null | "valid" = "valid"): Promise<Reply> {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature === "valid") headers[OUTBOUND_SIGNATURE_HEADER] = signOutbound(secret(), raw);
  else if (signature !== null) headers[OUTBOUND_SIGNATURE_HEADER] = signature;
  const res = await app.inject({ method: "POST", url: "/outbound", headers, payload: raw });
  return { status: res.statusCode, json: res.json() };
}

const sentRows = async (id: string) => (await getPool().query("SELECT text FROM outbound_log WHERE message_id = $1", [id])).rows.length;
const flag = async (id: string) => (await getPool().query("SELECT auto_reply_sent FROM messages WHERE message_id = $1", [id])).rows[0].auto_reply_sent as boolean;

describe("who may call /outbound", () => {
  test("no signature: 401 and nothing recorded", async () => {
    const id = await message();
    const r = await post({ message_id: id, text: "Thanks, our team will check." }, null);
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { error: "unauthorized" });
    assert.equal(await sentRows(id), 0);
    assert.equal(await flag(id), false);
  });

  test("a wrong signature, a malformed one, and one made for the webhooks: 401", async () => {
    const id = await message();
    const body = JSON.stringify({ message_id: id, text: "Thanks, our team will check." });
    const wrong = "sha256=" + "0".repeat(64);
    const forWebhooks = sign(body); // valid for /webhooks, made with WEBHOOK_SECRET itself
    const otherLabel = "sha256=" + createHmac("sha256", createHmac("sha256", secret()).update("another label").digest("hex")).update(body).digest("hex");
    for (const sig of [wrong, "sha256=zz", "nonsense", forWebhooks, otherLabel, ""]) {
      const r = await post(body, sig);
      assert.equal(r.status, 401, sig.slice(0, 20));
    }
    assert.equal(await sentRows(id), 0);
  });

  test("a signature over other bytes does not carry over to a changed body", async () => {
    const id = await message();
    const signedFor = JSON.stringify({ message_id: id, text: "Thanks, our team will check." });
    const sent = JSON.stringify({ message_id: id, text: "Thanks, our team will check.", extra: 1 });
    const r = await post(sent, signOutbound(secret(), signedFor));
    assert.equal(r.status, 401);
  });
});

describe("what /outbound refuses even with a valid signature", () => {
  test("an unknown message: 404", async () => {
    const r = await post({ message_id: "M-nope", text: "hi" });
    assert.equal(r.status, 404);
  });

  test("a message that has not been triaged: 409", async () => {
    const id = await message({ status: "pending" });
    const r = await post({ message_id: id, text: "hi" });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "not_triaged");
    assert.equal(await sentRows(id), 0);
  });

  test("a refund_related message is held: 409, nothing recorded, not marked sent", async () => {
    const id = await message({ category: "refund_related", held: "refund_related", draft: "Our team will look at your message." });
    const r = await post({ message_id: id, text: "Our team will look at your message." });
    assert.equal(r.status, 409);
    assert.deepEqual(r.json, { error: "held", reason: "refund_related" });
    assert.equal(await sentRows(id), 0);
    assert.equal(await flag(id), false);
  });

  test("a flagged message is held whatever its category", async () => {
    const id = await message({ category: "other", flags: ["injection_suspected"], held: "injection_suspected" });
    const r = await post({ message_id: id, text: "Thanks, our team will check." });
    assert.equal(r.status, 409);
    assert.equal(r.json.reason, "injection_suspected");
    assert.equal(await sentRows(id), 0);
  });

  test("the rules are applied again here: a row that lost its held_reason is still refused", async () => {
    // a bug (or a hand edit) cleared held_reason; the category and the flag are still there
    const refundRelated = await message({ category: "refund_related", held: null });
    const flagged = await message({ category: "praise", flags: ["injection_suspected"], held: null });
    const cut = await message({ truncated: true, held: null });
    const promising = await message({ draft: "Your refund has been approved.", held: null });
    for (const [id, reason] of [
      [refundRelated, "refund_related"],
      [flagged, "injection_suspected"],
      [cut, "cut"],
      [promising, "draft_check"],
    ] as const) {
      const draft = (await getPool().query("SELECT draft_reply FROM messages WHERE message_id = $1", [id])).rows[0].draft_reply as string;
      const r = await post({ message_id: id, text: draft });
      assert.equal(r.status, 409, id);
      assert.equal(r.json.reason, reason, id);
      assert.equal(await sentRows(id), 0);
      assert.equal(await flag(id), false);
    }
  });

  test("text that is not the stored draft is refused: this endpoint sends the draft, nothing else", async () => {
    const id = await message({ draft: "Thanks, our team will check." });
    const r = await post({ message_id: id, text: "Your refund has been approved." });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "text_mismatch");
    assert.equal(await sentRows(id), 0);
  });

  test("a body that is not understood: 400", async () => {
    const id = await message();
    for (const body of ["not json", "[]", "{}", JSON.stringify({ message_id: id }), JSON.stringify({ message_id: id, text: "" }), JSON.stringify({ message_id: id, text: "hi", extra: true }), JSON.stringify({ message_id: 7, text: "hi" })]) {
      const r = await post(body);
      assert.equal(r.status, 400, body);
    }
  });
});

describe("a reply is recorded once", () => {
  test("a good call is recorded and the message is marked sent", async () => {
    const id = await message({ draft: "Thanks for the kind words!", category: "praise" });
    const r = await post({ message_id: id, text: "Thanks for the kind words!" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { status: "sent" });
    assert.equal(await sentRows(id), 1);
    assert.equal(await flag(id), true);
    const row = (await getPool().query("SELECT text FROM outbound_log WHERE message_id = $1", [id])).rows[0];
    assert.equal(row.text, "Thanks for the kind words!");
  });

  test("the same call again is acknowledged and records nothing more", async () => {
    const id = await message();
    const first = await post({ message_id: id, text: "Thanks, our team will check." });
    const second = await post({ message_id: id, text: "Thanks, our team will check." });
    assert.equal(first.json.status, "sent");
    assert.equal(second.status, 200);
    assert.equal(second.json.status, "already_sent");
    assert.equal(await sentRows(id), 1);
  });

  test("ten simultaneous calls: one record, one 'sent', nine 'already_sent'", async () => {
    const id = await message();
    const replies = await Promise.all(Array.from({ length: 10 }, () => post({ message_id: id, text: "Thanks, our team will check." })));
    assert.ok(replies.every((r) => r.status === 200));
    assert.equal(replies.filter((r) => r.json.status === "sent").length, 1);
    assert.equal(replies.filter((r) => r.json.status === "already_sent").length, 9);
    assert.equal(await sentRows(id), 1);
  });

  test("the answer to a signed call does not echo the text or any secret", async () => {
    const id = await message();
    const res = await app.inject({
      method: "POST",
      url: "/outbound",
      headers: { "content-type": "application/json", [OUTBOUND_SIGNATURE_HEADER]: signOutbound(secret(), JSON.stringify({ message_id: id, text: "Thanks, our team will check." })) },
      payload: JSON.stringify({ message_id: id, text: "Thanks, our team will check." }),
    });
    assert.ok(!res.body.includes(secret()));
    assert.ok(!res.body.includes("Thanks"));
  });
});

describe("the database refuses what the policy must never reach", () => {
  const code = (expected: string) => (err: unknown) => (err as { code?: string }).code === expected;
  const markSent = (id: string) => getPool().query("UPDATE messages SET auto_reply_sent = true WHERE message_id = $1", [id]);

  test("a refund_related, flagged, cut, held or untriaged message cannot be marked sent", async () => {
    await assert.rejects(markSent(await message({ category: "refund_related" })), code("23514"));
    await assert.rejects(markSent(await message({ flags: ["injection_suspected"] })), code("23514"));
    await assert.rejects(markSent(await message({ truncated: true })), code("23514"));
    await assert.rejects(markSent(await message({ held: "draft_check" })), code("23514"));
    await assert.rejects(markSent(await message({ status: "pending" })), code("23514"));
  });

  test("a finished triage must have its three results", async () => {
    const id = await message({ status: "pending" });
    await assert.rejects(getPool().query("UPDATE messages SET triage_status = 'done' WHERE message_id = $1", [id]), code("23514"));
  });

  test("a message has at most one outbound record", async () => {
    const id = await message();
    await getPool().query("INSERT INTO outbound_log (message_id, text) VALUES ($1, 'a')", [id]);
    await assert.rejects(getPool().query("INSERT INTO outbound_log (message_id, text) VALUES ($1, 'b')", [id]), code("23505"));
  });
});
