import { createHash } from "node:crypto";
import type pg from "pg";
import { withTransaction } from "./db.js";
import { recordDeadLetter } from "./deadLetter.js";
import type { ParsedEvent } from "./events.js";
import { decideRefund, type OrderState } from "./policy.js";

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
 * One order at a time. Everything that can change an order's balance or its refunds takes this lock first,
 * also when the order row does not exist yet: a refund being parked and the late order.created that should
 * decide it must not pass each other. Transaction-level, so it is safe behind Neon's pooler.
 */
async function lockOrder(client: pg.PoolClient, orderId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [orderId]);
}

/** The order as the policy needs it, with its row locked. null when no order.created was seen. */
async function loadOrderState(client: pg.PoolClient, orderId: string): Promise<OrderState | null> {
  const order = await client.query<{ currency: string; total_minor: number; refunded_minor: number }>(
    "SELECT currency, total_minor, refunded_minor FROM orders WHERE order_id = $1 FOR UPDATE",
    [orderId],
  );
  if (order.rowCount === 0) return null;
  const facts = await client.query<{ kind: string; occurred_at: Date }>("SELECT kind, occurred_at FROM order_events WHERE order_id = $1", [orderId]);
  const row = order.rows[0]!;
  return {
    currency: row.currency,
    totalMinor: Number(row.total_minor),
    refundedMinor: Number(row.refunded_minor),
    deliveredAt: facts.rows.find((f) => f.kind === "delivered")?.occurred_at ?? null,
    cancelledAt: facts.rows.find((f) => f.kind === "cancelled")?.occurred_at ?? null,
  };
}

/** The late order has arrived: decide the refunds that were waiting for it, in the order they happened. */
async function decideParkedRefunds(client: pg.PoolClient, orderId: string): Promise<void> {
  const order = await loadOrderState(client, orderId);
  if (!order) return;
  const parked = await client.query<{ refund_id: string; amount_minor: number; currency: string; reason: string; occurred_at: Date }>(
    `SELECT refund_id, amount_minor, currency, reason, occurred_at FROM refunds
     WHERE order_id = $1 AND decision = 'parked' ORDER BY occurred_at, refund_id`,
    [orderId],
  );
  for (const refund of parked.rows) {
    const amountMinor = Number(refund.amount_minor);
    const d = decideRefund({ amountMinor, currency: refund.currency, reason: refund.reason, occurredAt: refund.occurred_at }, order);
    await client.query(
      `UPDATE refunds SET decision = $2, reason_code = $3, decided_by = $4::text, note = $5,
         decided_at = CASE WHEN $4::text = 'none' THEN NULL ELSE now() END
       WHERE refund_id = $1`,
      [refund.refund_id, d.decision, d.reasonCode, d.decidedBy, d.note],
    );
    if (d.decision === "auto_approved") {
      order.refundedMinor += amountMinor;
      await client.query("UPDATE orders SET refunded_minor = $2 WHERE order_id = $1", [orderId, order.refundedMinor]);
    }
  }
}

/**
 * Marks the event as seen and applies it in ONE transaction, so a crash can neither lose an event
 * (marked seen, never applied) nor apply it twice (applied, never marked).
 *
 * Duplicate: same event id and identical body. Counted in events.redeliveries, nothing else changes.
 * Conflict: same event id with another body, or a different event creating an order, delivery,
 * cancellation, message or refund we already have. Nothing is overwritten and the whole transaction is
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
          await lockOrder(client, event.orderId);
          const r = await client.query(
            `INSERT INTO orders (order_id, customer_email, currency, total_minor, created_at, event_id)
             VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (order_id) DO NOTHING`,
            [event.orderId, event.customerEmail, event.currency, event.totalMinor, event.occurredAt.toISOString(), eventId],
          );
          if (r.rowCount === 0) throw new Conflict("order already exists");
          await decideParkedRefunds(client, event.orderId);
          break;
        }
        case "shipment.delivered":
        case "order.cancelled": {
          const kind = event.kind === "shipment.delivered" ? "delivered" : "cancelled";
          await lockOrder(client, event.orderId);
          // No check that the order exists: a delivery can arrive before its order.created.
          const r = await client.query(
            `INSERT INTO order_events (order_id, kind, occurred_at, event_id)
             VALUES ($1, $2, $3, $4) ON CONFLICT (order_id, kind) DO NOTHING`,
            [event.orderId, kind, event.occurredAt.toISOString(), eventId],
          );
          if (r.rowCount === 0) throw new Conflict(`order already ${kind}`);
          // A refund that was queued earlier is not decided again: POLICY.md has no re-check (HANDOFF.md).
          break;
        }
        case "refund.requested": {
          await lockOrder(client, event.orderId);
          const order = await loadOrderState(client, event.orderId);
          const d = decideRefund(
            { amountMinor: event.amountMinor, currency: event.currency, reason: event.reason, occurredAt: event.occurredAt },
            order,
          );
          const r = await client.query(
            `INSERT INTO refunds (refund_id, order_id, currency, amount_minor, reason, occurred_at,
                                  decision, reason_code, decided_by, note, decided_at, event_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text, $10, CASE WHEN $9::text = 'none' THEN NULL ELSE now() END, $11)
             ON CONFLICT (refund_id) DO NOTHING`,
            [
              event.refundId,
              event.orderId,
              event.currency,
              event.amountMinor,
              event.reason,
              event.occurredAt.toISOString(),
              d.decision,
              d.reasonCode,
              d.decidedBy,
              d.note,
              eventId,
            ],
          );
          if (r.rowCount === 0) throw new Conflict("refund already exists");
          if (d.decision === "auto_approved") {
            await client.query("UPDATE orders SET refunded_minor = refunded_minor + $2 WHERE order_id = $1", [event.orderId, event.amountMinor]);
          }
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
