import { createHash } from "node:crypto";
import { withTransaction } from "./db.js";
import { recordDeadLetter } from "./deadLetter.js";
import type { ParsedEvent } from "./events.js";

export type ApplyStatus = "accepted" | "duplicate" | "unknown_type" | "dead_lettered";

export interface ApplyInput {
  eventId: string;
  raw: Buffer;
  text: string;
  event: ParsedEvent;
}

/** A second, different event tries to create something we already have. First wins. */
class Conflict extends Error {}

/**
 * Marks the event as seen and applies it in ONE transaction, so a crash can neither lose an event
 * (marked seen, never applied) nor apply it twice (applied, never marked).
 *
 * Duplicate: same event id and identical body. Counted in events.redeliveries, nothing else changes.
 * Conflict: same event id with another body, or a different event creating an order, delivery,
 * cancellation or message we already have. Nothing is overwritten and the whole transaction is
 * rolled back, then the event is listed in dead_letter as invalid_event.
 *
 * Errors other than a conflict (database down, ...) are thrown: the caller answers 503 so the sender retries.
 */
export async function applyEvent(input: ApplyInput): Promise<{ status: ApplyStatus }> {
  const { eventId, event } = input;
  const bodySha256 = createHash("sha256").update(input.raw).digest("hex");

  try {
    return await withTransaction(async (client) => {
      // One statement does the duplicate check and the count, so two simultaneous deliveries cannot both be "first".
      // New row: redeliveries is 0. Same id, same body: the update runs and redeliveries is 1 or more.
      // Same id, different body: the WHERE fails, nothing is returned.
      const seen = await client.query<{ redeliveries: number }>(
        `INSERT INTO events (event_id, body_sha256, body, type, outcome, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (event_id) DO UPDATE SET redeliveries = events.redeliveries + 1
           WHERE events.body_sha256 = EXCLUDED.body_sha256
         RETURNING redeliveries`,
        [
          eventId,
          bodySha256,
          input.text,
          event.kind === "unknown" ? event.type : event.kind,
          event.kind === "unknown" ? "unknown_type" : "applied",
          event.occurredAt.toISOString(),
        ],
      );
      if (seen.rowCount === 0) throw new Conflict("same event id with a different body");
      if (seen.rows[0]!.redeliveries > 0) return { status: "duplicate" as const };

      switch (event.kind) {
        case "order.created": {
          const r = await client.query(
            `INSERT INTO orders (order_id, customer_email, currency, total_minor, created_at, event_id)
             VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (order_id) DO NOTHING`,
            [event.orderId, event.customerEmail, event.currency, event.totalMinor, event.occurredAt.toISOString(), eventId],
          );
          if (r.rowCount === 0) throw new Conflict("order already exists");
          break;
        }
        case "shipment.delivered":
        case "order.cancelled": {
          const kind = event.kind === "shipment.delivered" ? "delivered" : "cancelled";
          // No check that the order exists: a delivery can arrive before its order.created.
          const r = await client.query(
            `INSERT INTO order_events (order_id, kind, occurred_at, event_id)
             VALUES ($1, $2, $3, $4) ON CONFLICT (order_id, kind) DO NOTHING`,
            [event.orderId, kind, event.occurredAt.toISOString(), eventId],
          );
          if (r.rowCount === 0) throw new Conflict(`order already ${kind}`);
          break;
        }
        case "message.received": {
          const r = await client.query(
            `INSERT INTO messages (message_id, order_id, channel, text, occurred_at, event_id)
             VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (message_id) DO NOTHING`,
            [event.messageId, event.orderId, event.channel, event.text, event.occurredAt.toISOString(), eventId],
          );
          if (r.rowCount === 0) throw new Conflict("message already exists");
          break;
        }
        case "refund.requested":
          // Phase 3: the refund row and the policy decision. For now the event is validated and recorded in events.
          break;
        case "unknown":
          return { status: "unknown_type" as const };
      }
      return { status: "accepted" as const };
    });
  } catch (err) {
    if (err instanceof Conflict) {
      await recordDeadLetter(eventId, "invalid_event", err.message);
      return { status: "dead_lettered" };
    }
    throw err;
  }
}
