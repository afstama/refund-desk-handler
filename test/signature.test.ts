import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";
import { signatureMatches } from "../src/signature.js";

const secret = "test-secret-not-the-real-one";
const sign = (body: Buffer | string) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

describe("signatureMatches", () => {
  const body = Buffer.from('{"id":"evt_1","type":"order.cancelled"}');

  test("accepts the HMAC of the exact bytes", () => {
    assert.equal(signatureMatches(secret, body, sign(body)), true);
  });

  test("uppercase hex is the same bytes", () => {
    const header = "sha256=" + sign(body).slice(7).toUpperCase();
    assert.equal(signatureMatches(secret, body, header), true);
  });

  test("any change to the bytes breaks it, including formatting and a trailing newline", () => {
    const header = sign(body);
    assert.equal(signatureMatches(secret, Buffer.from(body.toString() + "\n"), header), false);
    assert.equal(signatureMatches(secret, Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2)), header), false);
    assert.equal(signatureMatches(secret, Buffer.from(body.toString().replace("evt_1", "evt_2")), header), false);
  });

  test("the secret matters", () => {
    assert.equal(signatureMatches("another-secret", body, sign(body)), false);
  });

  test("non-ASCII bodies are signed as UTF-8 bytes", () => {
    const text = Buffer.from('{"text":"Merci beaucoup 👍"}', "utf8");
    assert.equal(signatureMatches(secret, text, sign(text)), true);
  });

  test("missing or malformed headers never match", () => {
    const hex = sign(body).slice(7);
    for (const header of [undefined, "", "sha256=", "sha256=abc", `sha1=${hex}`, hex, `sha256=${hex}00`, `sha256=${hex.slice(1)}`, `sha256=${"g".repeat(64)}`, ` sha256=${hex}`]) {
      assert.equal(signatureMatches(secret, body, header), false, String(header));
    }
  });

  test("an empty body can be signed too", () => {
    assert.equal(signatureMatches(secret, Buffer.alloc(0), sign(Buffer.alloc(0))), true);
  });
});
