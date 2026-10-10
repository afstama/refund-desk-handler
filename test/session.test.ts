import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { authenticate, bearerToken, isSecureRequest, SAME_ORIGIN_HEADER, SAME_ORIGIN_VALUE, tokenMatches } from "../src/auth.js";
import { clearedCookie, cookieName, issueSession, readCookie, SESSION_SECONDS, sessionCookie, sessionIsValid } from "../src/session.js";

const TOKEN = "a-test-token-that-is-not-the-real-one";
const T0 = Date.UTC(2026, 3, 14, 9, 0, 0); // a fixed "now"

describe("session cookie value", () => {
  test("is valid until its expiry second, and not after", () => {
    const { value, maxAge } = issueSession(TOKEN, T0);
    assert.equal(maxAge, SESSION_SECONDS);
    assert.equal(sessionIsValid(TOKEN, value, T0), true);
    assert.equal(sessionIsValid(TOKEN, value, T0 + (SESSION_SECONDS - 1) * 1000), true);
    assert.equal(sessionIsValid(TOKEN, value, T0 + SESSION_SECONDS * 1000), false);
    assert.equal(sessionIsValid(TOKEN, value, T0 + (SESSION_SECONDS + 3600) * 1000), false);
  });

  test("has the documented shape and does not contain the token", () => {
    const { value } = issueSession(TOKEN, T0);
    assert.match(value, /^v1\.\d{10}\.[A-Za-z0-9_-]{43}$/);
    assert.ok(!value.includes(TOKEN));
    assert.equal(value.split(".")[1], String(Math.floor(T0 / 1000) + SESSION_SECONDS));
  });

  test("a cookie made with another token is not valid: changing APPROVER_TOKEN signs everyone out", () => {
    const { value } = issueSession("another-token", T0);
    assert.equal(sessionIsValid(TOKEN, value, T0), false);
  });

  test("any change to it is refused: expiry, version, signature, length", () => {
    const { value } = issueSession(TOKEN, T0);
    const [version, expiry, mac] = value.split(".") as [string, string, string];
    const flipped = mac.slice(0, -1) + (mac.endsWith("A") ? "B" : "A");
    const tampered = [
      `${version}.${Number(expiry) + 1}.${mac}`, // a later expiry with the old signature
      `${version}.${Number(expiry) + 86400 * 365}.${mac}`,
      `v2.${expiry}.${mac}`,
      `${version}.${expiry}.${flipped}`,
      `${version}.${expiry}.${mac.slice(1)}`,
      `${version}.${expiry}.${mac}x`,
      `${version}.${expiry}`,
      `${value}.extra`,
      "",
      "v1..",
      "garbage",
      `${value}${"a".repeat(300)}`,
    ];
    for (const t of tampered) assert.equal(sessionIsValid(TOKEN, t, T0), false, t.slice(0, 60));
    assert.equal(sessionIsValid(TOKEN, undefined, T0), false);
    assert.equal(sessionIsValid(TOKEN, 123 as unknown as string, T0), false);
  });

  test("the same moment gives the same value, a different moment a different one", () => {
    assert.equal(issueSession(TOKEN, T0).value, issueSession(TOKEN, T0).value);
    assert.notEqual(issueSession(TOKEN, T0).value, issueSession(TOKEN, T0 + 2000).value);
  });
});

describe("cookie header and attributes", () => {
  test("readCookie finds one cookie among several, first one wins, malformed parts are ignored", () => {
    assert.equal(readCookie("a=1; refund_desk_session=abc; b=2", "refund_desk_session"), "abc");
    assert.equal(readCookie("refund_desk_session=first; refund_desk_session=second", "refund_desk_session"), "first");
    assert.equal(readCookie("  refund_desk_session = abc ", "refund_desk_session"), "abc");
    assert.equal(readCookie("xrefund_desk_session=abc", "refund_desk_session"), undefined);
    assert.equal(readCookie("noequalsign; =novalue", "refund_desk_session"), undefined);
    assert.equal(readCookie(undefined, "x"), undefined);
    assert.equal(readCookie("a=" + "x".repeat(5000), "a"), undefined);
  });

  test("over HTTP: HttpOnly, SameSite=Strict, Path=/, Max-Age, no Secure, plain name", () => {
    const header = sessionCookie("v1.1.abc", 28800, false);
    assert.equal(cookieName(false), "refund_desk_session");
    assert.ok(header.startsWith("refund_desk_session=v1.1.abc; "));
    for (const part of ["Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=28800"]) assert.ok(header.includes(part), part);
    assert.ok(!header.includes("Secure"));
    assert.ok(!header.includes("Domain"));
  });

  test("over HTTPS: Secure and the __Host- prefix (no Domain, Path=/)", () => {
    const header = sessionCookie("v1.1.abc", 28800, true);
    assert.equal(cookieName(true), "__Host-refund_desk_session");
    assert.ok(header.startsWith("__Host-refund_desk_session=v1.1.abc; "));
    for (const part of ["Path=/", "HttpOnly", "SameSite=Strict", "Secure", "Max-Age=28800"]) assert.ok(header.includes(part), part);
    assert.ok(!header.includes("Domain"));
  });

  test("the cleared cookie expires at once", () => {
    for (const secure of [false, true]) {
      const header = clearedCookie(secure);
      assert.ok(header.startsWith(`${cookieName(secure)}=;`));
      assert.ok(header.includes("Max-Age=0") && header.includes("Expires=Thu, 01 Jan 1970"));
    }
  });

  test("production and HTTPS both count as secure", () => {
    assert.equal(isSecureRequest("http", "production"), true);
    assert.equal(isSecureRequest("https", undefined), true);
    assert.equal(isSecureRequest("http", "development"), false);
    assert.equal(isSecureRequest("http", undefined), false);
  });
});

describe("authenticate", () => {
  const session = (nowMs = T0) => `${cookieName(false)}=${issueSession(TOKEN, nowMs).value}`;
  const sameOrigin = { [SAME_ORIGIN_HEADER]: SAME_ORIGIN_VALUE };

  test("the Bearer header, as the contract has it", () => {
    assert.equal(authenticate({ authorization: `Bearer ${TOKEN}` }, TOKEN, false, T0), "bearer");
    assert.equal(authenticate({ authorization: `bearer ${TOKEN}` }, TOKEN, false, T0), "bearer");
    assert.equal(authenticate({ authorization: "Bearer wrong" }, TOKEN, false, T0), null);
    assert.equal(authenticate({ authorization: TOKEN }, TOKEN, false, T0), null);
  });

  test("a session needs the cookie AND the same-origin header", () => {
    assert.equal(authenticate({ cookie: session(), ...sameOrigin }, TOKEN, false, T0), "session");
    assert.equal(authenticate({ cookie: session() }, TOKEN, false, T0), null);
    assert.equal(authenticate({ ...sameOrigin }, TOKEN, false, T0), null);
    assert.equal(authenticate({ cookie: session(), [SAME_ORIGIN_HEADER]: "something-else" }, TOKEN, false, T0), null);
  });

  test("an expired or foreign session is nothing, and a good Bearer still works next to a bad cookie", () => {
    assert.equal(authenticate({ cookie: session(T0 - (SESSION_SECONDS + 10) * 1000), ...sameOrigin }, TOKEN, false, T0), null);
    const foreign = `${cookieName(false)}=${issueSession("other", T0).value}`;
    assert.equal(authenticate({ cookie: foreign, ...sameOrigin }, TOKEN, false, T0), null);
    assert.equal(authenticate({ cookie: foreign, authorization: `Bearer ${TOKEN}` }, TOKEN, false, T0), "bearer");
  });

  test("over HTTPS only the __Host- cookie counts: the plain name is ignored", () => {
    const plain = `${cookieName(false)}=${issueSession(TOKEN, T0).value}`;
    const prefixed = `${cookieName(true)}=${issueSession(TOKEN, T0).value}`;
    assert.equal(authenticate({ cookie: plain, ...sameOrigin }, TOKEN, true, T0), null);
    assert.equal(authenticate({ cookie: prefixed, ...sameOrigin }, TOKEN, true, T0), "session");
  });
});

describe("token helpers", () => {
  test("bearerToken and tokenMatches", () => {
    assert.equal(bearerToken("Bearer abc"), "abc");
    assert.equal(bearerToken("Basic abc"), null);
    assert.equal(tokenMatches("s3cret", "s3cret"), true);
    assert.equal(tokenMatches("s3cret", "s3cret "), false);
    assert.equal(tokenMatches("s3cret", null), false);
  });
});
