import { createHash, timingSafeEqual } from "node:crypto";

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
