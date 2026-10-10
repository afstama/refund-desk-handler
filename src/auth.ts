import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { cookieName, readCookie, sessionIsValid } from "./session.js";

/** The token from "Authorization: Bearer <token>". The scheme name is case-insensitive. null when absent or malformed. */
export function bearerToken(header: string | undefined): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer +(\S+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

/**
 * Constant-time comparison. Both sides are hashed first, so the two buffers always have the same length and
 * neither the content nor the length of the real token can be learned from how long the answer takes.
 */
export function tokenMatches(expected: string, given: string | null): boolean {
  if (given === null) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(given).digest();
  return timingSafeEqual(a, b);
}

/** The header a cookie-authenticated request must carry. A page on another site cannot add it without CORS, which we never allow. */
export const SAME_ORIGIN_HEADER = "x-requested-with";
export const SAME_ORIGIN_VALUE = "refund-desk";

/** Over HTTPS (or in production, which runs behind an HTTPS proxy) the cookie is Secure and carries the __Host- prefix. */
export function isSecureRequest(protocol: string, nodeEnv: string | undefined): boolean {
  return nodeEnv === "production" || protocol === "https";
}

/**
 * Who is asking, and how they proved it.
 *   "bearer"  the Authorization header, exactly as CONTRACT.md has it (Qure's tool, scripts)
 *   "session" the login cookie, and only together with the same-origin header
 *   null      neither
 * One answer for every way of failing: the caller learns nothing about why.
 */
export function authenticate(headers: IncomingHttpHeaders, token: string, secure: boolean, nowMs = Date.now()): "bearer" | "session" | null {
  if (tokenMatches(token, bearerToken(headers.authorization))) return "bearer";
  const cookie = readCookie(headers.cookie, cookieName(secure));
  if (sessionIsValid(token, cookie, nowMs) && headers[SAME_ORIGIN_HEADER] === SAME_ORIGIN_VALUE) return "session";
  return null;
}
