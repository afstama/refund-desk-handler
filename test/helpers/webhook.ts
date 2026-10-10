import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getConfig } from "../../src/config.js";

/** The signature Qure's sender would put on this body, using the real WEBHOOK_SECRET from .env. */
export function sign(body: Buffer | string): string {
  return "sha256=" + createHmac("sha256", getConfig().WEBHOOK_SECRET).update(body).digest("hex");
}

export interface DeliverOptions {
  /** undefined: sign the body correctly. null: send no signature header. A string: send exactly that. */
  signature?: string | null;
  contentType?: string;
  /** Path to post to. Default "/webhooks". */
  url?: string;
}

/** One POST /webhooks. `eventId` undefined means no X-Event-Id header. */
export async function deliver(app: FastifyInstance, eventId: string | undefined, body: Buffer | string, opts: DeliverOptions = {}) {
  const headers: Record<string, string> = { "content-type": opts.contentType ?? "application/json" };
  if (eventId !== undefined) headers["x-event-id"] = eventId;
  const signature = opts.signature === undefined ? sign(body) : opts.signature;
  if (signature !== null) headers["x-signature"] = signature;
  const res = await app.inject({ method: "POST", url: opts.url ?? "/webhooks", headers, payload: body });
  return { status: res.statusCode, json: res.json() as Record<string, unknown> };
}

export function event(id: string, type: string, payload: unknown, occurredAt = "2026-04-01T10:00:00Z"): string {
  return JSON.stringify({ id, type, occurred_at: occurredAt, payload });
}

export const orderCreated = (id: string, orderId: string, total = "10.00") =>
  event(id, "order.created", { order_id: orderId, customer_email: "a@example.com", total, currency: "EUR" });
