import type pg from "pg";
import type { OrderState } from "./policy.js";

/**
 * One order at a time. Everything that can change an order's balance or its refunds takes this lock first,
 * also when the order row does not exist yet: a refund being parked and the late order.created that should
 * decide it must not pass each other, and a human approval must not pass an incoming refund or cancellation.
 * Transaction-level, so it is safe behind Neon's pooler. The webhook pipeline and the approval code both use it.
 */
export async function lockOrder(client: pg.PoolClient, orderId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [orderId]);
}

/** The order as the policy needs it, with its row locked. null when no order.created was seen. */
export async function loadOrderState(client: pg.PoolClient, orderId: string): Promise<OrderState | null> {
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
