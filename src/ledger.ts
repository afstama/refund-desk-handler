import type pg from "pg";
import { getPool } from "./db.js";

// The shape of GET /ledger from CONTRACT.md. Money is whole minor units in the record's own currency.
// Public and unauthenticated, as the contract has it: never put an email address or message text in here.

export type OrderStatus = "created" | "delivered" | "cancelled";

export interface LedgerOrder {
  status: OrderStatus;
  currency: string;
  total_minor: number;
  refunded_minor: number;
}

export interface LedgerRefund {
  order_id: string;
  currency: string;
  amount_minor: number;
  decision: string;
  reason_code: string;
  decided_by: string;
  // Extra fields (Marko allows them): what the customer gave as the reason, and why a human has to look.
  reason: string;
  note: string | null;
}

export interface LedgerMessage {
  category: string;
  sentiment: string;
  draft_reply: string;
  flags: string[];
  auto_reply_sent: boolean;
}

export interface LedgerDeadLetter {
  event_id: string;
  reason: string;
  /** Extra field: a short text that names the field and never a raw value. */
  detail: string | null;
}

export interface Ledger {
  orders: Record<string, LedgerOrder>;
  refunds: Record<string, LedgerRefund>;
  messages: Record<string, LedgerMessage>;
  dead_letter: LedgerDeadLetter[];
  duplicates_ignored: number;
  unknown_types_acked: number;
}

/** Plain rows as they come from the database. */
export interface LedgerRows {
  orders: { order_id: string; currency: string; total_minor: number; refunded_minor: number }[];
  orderEvents: { order_id: string; kind: string }[];
  refunds: {
    refund_id: string;
    order_id: string;
    currency: string;
    amount_minor: number;
    decision: string;
    reason_code: string;
    decided_by: string;
    reason: string;
    note: string | null;
  }[];
  /** Only messages whose triage is done. A message still being triaged is not listed yet. */
  messages: { message_id: string; category: string; sentiment: string; draft_reply: string; flags: string[]; auto_reply_sent: boolean }[];
  deadLetter: { event_id: string; reason: string; detail: string | null }[];
  duplicatesIgnored: number;
  unknownTypesAcked: number;
}

/**
 * Pure: rows in, contract shape out.
 * An order's status comes from its events: cancelled wins over delivered, delivered over created (Ana's choice).
 */
export function assembleLedger(rows: LedgerRows): Ledger {
  const cancelled = new Set<string>();
  const delivered = new Set<string>();
  for (const e of rows.orderEvents) {
    if (e.kind === "cancelled") cancelled.add(e.order_id);
    else if (e.kind === "delivered") delivered.add(e.order_id);
  }

  const orders: Record<string, LedgerOrder> = {};
  for (const o of rows.orders) {
    orders[o.order_id] = {
      status: cancelled.has(o.order_id) ? "cancelled" : delivered.has(o.order_id) ? "delivered" : "created",
      currency: o.currency,
      total_minor: Number(o.total_minor),
      refunded_minor: Number(o.refunded_minor),
    };
  }

  const refunds: Record<string, LedgerRefund> = {};
  for (const r of rows.refunds) {
    refunds[r.refund_id] = {
      order_id: r.order_id,
      currency: r.currency,
      amount_minor: Number(r.amount_minor),
      decision: r.decision,
      reason_code: r.reason_code,
      decided_by: r.decided_by,
      reason: r.reason,
      note: r.note ?? null,
    };
  }

  const messages: Record<string, LedgerMessage> = {};
  for (const m of rows.messages) {
    messages[m.message_id] = {
      category: m.category,
      sentiment: m.sentiment,
      draft_reply: m.draft_reply,
      flags: m.flags ?? [],
      auto_reply_sent: m.auto_reply_sent,
    };
  }

  return {
    orders,
    refunds,
    messages,
    dead_letter: rows.deadLetter.map((d) => ({ event_id: d.event_id, reason: d.reason, detail: d.detail ?? null })),
    duplicates_ignored: Number(rows.duplicatesIgnored),
    unknown_types_acked: Number(rows.unknownTypesAcked),
  };
}

/**
 * Reads everything in ONE snapshot (repeatable read, read only), so an order's refunded_minor always agrees with
 * the refunds listed next to it, even while events are being applied. Keys come out in a stable order.
 */
export async function readLedger(pool: pg.Pool = getPool()): Promise<Ledger> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const orders = await client.query<LedgerRows["orders"][number]>(
      "SELECT order_id, currency, total_minor, refunded_minor FROM orders ORDER BY order_id",
    );
    const orderEvents = await client.query<LedgerRows["orderEvents"][number]>("SELECT order_id, kind FROM order_events");
    const refunds = await client.query<LedgerRows["refunds"][number]>(
      `SELECT refund_id, order_id, currency, amount_minor, decision, reason_code, decided_by, reason, note
       FROM refunds ORDER BY refund_id`,
    );
    const messages = await client.query<LedgerRows["messages"][number]>(
      `SELECT message_id, category, sentiment, draft_reply, flags, auto_reply_sent
       FROM messages WHERE triage_status = 'done' ORDER BY message_id`,
    );
    const deadLetter = await client.query<LedgerRows["deadLetter"][number]>("SELECT event_id, reason, detail FROM dead_letter ORDER BY id");
    const counters = await client.query<{ duplicates: number; unknown: number }>(
      `SELECT COALESCE(sum(redeliveries), 0)::bigint AS duplicates,
              count(*) FILTER (WHERE outcome = 'unknown_type')::bigint AS unknown
       FROM events`,
    );
    await client.query("COMMIT");
    return assembleLedger({
      orders: orders.rows,
      orderEvents: orderEvents.rows,
      refunds: refunds.rows,
      messages: messages.rows,
      deadLetter: deadLetter.rows,
      duplicatesIgnored: counters.rows[0]!.duplicates,
      unknownTypesAcked: counters.rows[0]!.unknown,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
