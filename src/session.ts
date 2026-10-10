import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// A session is a signed expiry time and nothing else: no table, no identity, no copy of the token.
//   cookie value = v1.<expiry as unix seconds>.<base64url HMAC-SHA256 of "v1.<expiry>">
// The signing key is derived from APPROVER_TOKEN, so no new setting exists, and changing the token signs
// everyone out. The price of having no table: a stolen cookie cannot be cancelled before it expires.

export const SESSION_SECONDS = 8 * 60 * 60; // one shift

const COOKIE_NAME = "refund_desk_session";
/** Over HTTPS the __Host- prefix makes the browser refuse the cookie unless it is Secure, Path=/ and has no Domain. */
const SECURE_COOKIE_NAME = "__Host-refund_desk_session";

function signingKey(token: string): Buffer {
  return createHash("sha256").update(`refund-desk session v1\0${token}`).digest();
}

export function issueSession(token: string, nowMs = Date.now(), lifetimeSeconds = SESSION_SECONDS): { value: string; maxAge: number } {
  const expiry = Math.floor(nowMs / 1000) + lifetimeSeconds;
  const body = `v1.${expiry}`;
  const mac = createHmac("sha256", signingKey(token)).update(body).digest("base64url");
  return { value: `${body}.${mac}`, maxAge: lifetimeSeconds };
}

export function sessionIsValid(token: string, cookieValue: string | undefined, nowMs = Date.now()): boolean {
  if (typeof cookieValue !== "string" || cookieValue.length > 200) return false;
  const match = /^(v1)\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(cookieValue);
  if (!match) return false;
  const expected = createHmac("sha256", signingKey(token)).update(`${match[1]}.${match[2]}`).digest();
  const given = Buffer.from(match[3]!, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  return Number(match[2]) > Math.floor(nowMs / 1000);
}

export function cookieName(secure: boolean): string {
  return secure ? SECURE_COOKIE_NAME : COOKIE_NAME;
}

/** The value of one cookie from a Cookie header. The first one with that name wins. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (typeof header !== "string" || header.length > 4096) return undefined;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

function attributes(secure: boolean): string {
  // HttpOnly: the page's script cannot read it. SameSite=Strict: another site cannot make the browser send it.
  return `Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function sessionCookie(value: string, maxAge: number, secure: boolean): string {
  return `${cookieName(secure)}=${value}; ${attributes(secure)}; Max-Age=${maxAge}`;
}

export function clearedCookie(secure: boolean): string {
  return `${cookieName(secure)}=; ${attributes(secure)}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
