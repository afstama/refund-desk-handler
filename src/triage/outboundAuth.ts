import { createHmac } from "node:crypto";
import { signatureMatches } from "../signature.js";

// POST /outbound is called only by this service's own worker. The call is signed so that nobody else can make the
// service record a reply as sent. The key is derived from WEBHOOK_SECRET under its own label: a signature made for a
// webhook is useless here and the other way round, and there is no new secret to configure.

export const OUTBOUND_SIGNATURE_HEADER = "x-outbound-signature";
const LABEL = "refund-desk outbound v1";

function outboundKey(webhookSecret: string): string {
  return createHmac("sha256", webhookSecret).update(LABEL).digest("hex");
}

export function signOutbound(webhookSecret: string, body: Buffer | string): string {
  return "sha256=" + createHmac("sha256", outboundKey(webhookSecret)).update(body).digest("hex");
}

export function outboundSignatureMatches(webhookSecret: string, raw: Buffer, header: string | undefined): boolean {
  return signatureMatches(outboundKey(webhookSecret), raw, header);
}
