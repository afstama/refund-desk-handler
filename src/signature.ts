import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * True when `header` is "sha256=<hex>" and the hex is the HMAC-SHA256 of the raw body bytes under `secret`.
 * The bytes are used exactly as they arrived: re-serialised JSON would not match.
 */
export function signatureMatches(secret: string, raw: Buffer, header: string | undefined): boolean {
  if (typeof header !== "string") return false;
  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(header);
  if (!match) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(match[1]!, "hex"));
}
