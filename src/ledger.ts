import type pg from "pg";
import { getPool } from "./db.js";
import { convertMinor, toEurMinor } from "./policy.js";

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
  /**
   * Extra field: what an approval counted against the order, in the order's currency (null until approved).
   * It is amount_minor when the currencies agree. orders.refunded_minor is the sum of it over approved refunds.
   */
  charged_minor: number | null;
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

/** Everything that is waiting for an order.created we have not seen. */
export interface LedgerUnmatched {
  /** "delivered" and/or "cancelled" events stored for this order id. */
  events: string[];
  parked_refunds: string[];
}

export interface Ledger {
  orders: Record<string, LedgerOrder>;
  refunds: Record<string, LedgerRefund>;
  messages: Record<string, LedgerMessage>;
  dead_letter: LedgerDeadLetter[];
  duplicates_ignored: number;
  unknown_types_acked: number;
  /**
   * Extra field. An order with no order.created cannot be listed under `orders` (no currency, no total), but its
   * delivery or cancellation and its parked refunds are stored. This makes them visible instead of silent.
   * Empty once every order has arrived.
   */
  unmatched_order_events: Record<string, LedgerUnmatched>;
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
    charged_minor: number | null;
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
 * Objects are built with Object.fromEntries, not assignment: an order id such as "__proto__" must stay a key.
 */
export function assembleLedger(rows: LedgerRows): Ledger {
  const cancelled = new Set<string>();
  const delivered = new Set<string>();
  for (const e of rows.orderEvents) {
    if (e.kind === "cancelled") cancelled.add(e.order_id);
    else if (e.kind === "delivered") delivered.add(e.order_id);
  }

  const orders: Record<string, LedgerOrder> = Object.fromEntries(
    rows.orders.map((o) => [
      o.order_id,
      {
        status: cancelled.has(o.order_id) ? "cancelled" : delivered.has(o.order_id) ? "delivered" : "created",
        currency: o.currency,
        total_minor: Number(o.total_minor),
        refunded_minor: Number(o.refunded_minor),
      } satisfies LedgerOrder,
    ]),
  );

  const refunds: Record<string, LedgerRefund> = Object.fromEntries(
    rows.refunds.map((r) => [
      r.refund_id,
      {
        order_id: r.order_id,
        currency: r.currency,
        amount_minor: Number(r.amount_minor),
        decision: r.decision,
        reason_code: r.reason_code,
        decided_by: r.decided_by,
        reason: r.reason,
        note: r.note ?? null,
        charged_minor: r.charged_minor === null || r.charged_minor === undefined ? null : Number(r.charged_minor),
      } satisfies LedgerRefund,
    ]),
  );

  const messages: Record<string, LedgerMessage> = Object.fromEntries(
    rows.messages.map((m) => [
      m.message_id,
      { category: m.category, sentiment: m.sentiment, draft_reply: m.draft_reply, flags: m.flags ?? [], auto_reply_sent: m.auto_reply_sent } satisfies LedgerMessage,
    ]),
  );

  // Facts and parked refunds for orders that have no order.created yet.
  const seen = new Set(rows.orders.map((o) => o.order_id));
  const waiting = new Map<string, { events: Set<string>; parked: string[] }>();
  const entry = (orderId: string) => {
    let e = waiting.get(orderId);
    if (!e) waiting.set(orderId, (e = { events: new Set(), parked: [] }));
    return e;
  };
  for (const e of rows.orderEvents) if (!seen.has(e.order_id)) entry(e.order_id).events.add(e.kind);
  for (const r of rows.refunds) if (r.decision === "parked" && !seen.has(r.order_id)) entry(r.order_id).parked.push(r.refund_id);
  const unmatched: Record<string, LedgerUnmatched> = Object.fromEntries(
    [...waiting.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([orderId, w]) => [orderId, { events: [...w.events].sort(), parked_refunds: [...w.parked].sort() }]),
  );

  return {
    orders,
    refunds,
    messages,
    dead_letter: rows.deadLetter.map((d) => ({ event_id: d.event_id, reason: d.reason, detail: d.detail ?? null })),
    duplicates_ignored: Number(rows.duplicatesIgnored),
    unknown_types_acked: Number(rows.unknownTypesAcked),
    unmatched_order_events: unmatched,
  };
}

/** A queued refund as the screen gets it: the ledger's fields plus its value in EUR and in the order's currency. */
export interface QueueRefund extends LedgerRefund {
  /** The refund in EUR at the fixed rates. null when its currency has no rate. */
  eur_minor: number | null;
  /** What approving it would count against the order, in the order's currency. null when there is no rate. */
  in_order_currency_minor: number | null;
}

export interface QueueOrder extends LedgerOrder {
  /** The order's numbers in EUR at the fixed rates. null when its currency has no rate. */
  total_eur_minor: number | null;
  refunded_eur_minor: number | null;
  remaining_eur_minor: number | null;
}

/** What the approval screen needs: the queued refunds and the orders they belong to, in the ledger's shape. */
export interface Queue {
  orders: Record<string, QueueOrder>;
  refunds: Record<string, QueueRefund>;
}

/**
 * The queued refunds and their orders, in one snapshot like the ledger. Private (session or Bearer): the screen
 * reads this instead of the public ledger, and it is the place for data the ledger must not carry.
 */
export async function readQueue(pool: pg.Pool = getPool()): Promise<Queue> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const refunds = await client.query<LedgerRows["refunds"][number]>(
      `SELECT refund_id, order_id, currency, amount_minor, decision, reason_code, decided_by, reason, note, charged_minor
       FROM refunds WHERE decision = 'queued' ORDER BY refund_id`,
    );
    const orderIds = [...new Set(refunds.rows.map((r) => r.order_id))];
    const orders = await client.query<LedgerRows["orders"][number]>(
      "SELECT order_id, currency, total_minor, refunded_minor FROM orders WHERE order_id = ANY($1) ORDER BY order_id",
      [orderIds],
    );
    const orderEvents = await client.query<LedgerRows["orderEvents"][number]>("SELECT order_id, kind FROM order_events WHERE order_id = ANY($1)", [orderIds]);
    await client.query("COMMIT");
    const shaped = assembleLedger({
      orders: orders.rows,
      orderEvents: orderEvents.rows,
      refunds: refunds.rows,
      messages: [],
      deadLetter: [],
      duplicatesIgnored: 0,
      unknownTypesAcked: 0,
    });
    // Everything in EUR as well, computed here with the same integer rules as the policy, so that the screen
    // does no arithmetic of its own. Only a currency without a fixed rate has no EUR value.
    const queueOrders: Record<string, QueueOrder> = Object.fromEntries(
      Object.entries(shaped.orders).map(([id, o]) => [
        id,
        {
          ...o,
          total_eur_minor: toEurMinor(o.total_minor, o.currency),
          refunded_eur_minor: toEurMinor(o.refunded_minor, o.currency),
          remaining_eur_minor: toEurMinor(o.total_minor - o.refunded_minor, o.currency),
        },
      ]),
    );
    const queueRefunds: Record<string, QueueRefund> = Object.fromEntries(
      Object.entries(shaped.refunds).map(([id, r]) => {
        const orderCurrency = Object.hasOwn(shaped.orders, r.order_id) ? shaped.orders[r.order_id]!.currency : null;
        return [
          id,
          {
            ...r,
            eur_minor: toEurMinor(r.amount_minor, r.currency),
            in_order_currency_minor: orderCurrency === null ? null : convertMinor(r.amount_minor, r.currency, orderCurrency),
          },
        ];
      }),
    );
    return { orders: queueOrders, refunds: queueRefunds };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
      `SELECT refund_id, order_id, currency, amount_minor, decision, reason_code, decided_by, reason, note, charged_minor
       FROM refunds ORDER BY refund_id`,
    );
    const messages = await client.query<LedgerRows["messages"][number]>(
      // Finished = triaged AND either answered or held. A message whose reply is on its way is not listed yet, so
      // `auto_reply_sent: false` always means "held" and never "not sent yet".
      `SELECT message_id, category, sentiment, draft_reply, flags, auto_reply_sent
       FROM messages WHERE triage_status = 'done' AND (auto_reply_sent OR held_reason IS NOT NULL) ORDER BY message_id`,
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
