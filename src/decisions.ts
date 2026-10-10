import { withTransaction } from "./db.js";
import { loadOrderState, lockOrder } from "./orderState.js";
import { convertMinor } from "./policy.js";

export type HumanAction = "approve" | "reject";

export interface RefundView {
  refund_id: string;
  order_id: string;
  currency: string;
  amount_minor: number;
  decision: string;
  reason_code: string;
  decided_by: string;
  reason: string;
  note: string | null;
  /** What the approval counted against the order, in the order's currency. null until the refund is approved. */
  charged_minor: number | null;
}

export type RefusalCode =
  | "unknown_refund" // 404
  | "already_decided" // 409: approved, rejected or auto-approved before
  | "not_queued" // 409: parked, waiting for its order (POLICY.md section 5 and 7)
  | "order_unknown" // 409: defensive, a queued refund always has its order
  | "order_cancelled" // 409: the order was cancelled after the refund was queued
  | "no_exchange_rate" // 409: the refund and the order are in different currencies and one has no fixed rate
  | "exceeds_balance"; // 409: no longer fits (POLICY.md section 7), the refund stays queued

export type HumanDecisionResult =
  | {
      ok: true;
      refund: RefundView;
      order: { order_id: string; currency: string; total_minor: number; refunded_minor: number; remaining_minor: number };
    }
  | {
      ok: false;
      status: 404 | 409;
      error: RefusalCode;
      /** For exceeds_balance: what is still refundable, and in which currency (the order's). */
      remaining_minor?: number;
      remaining_currency?: string;
      /** For already_decided and not_queued: where the refund stands. */
      refund?: Pick<RefundView, "decision" | "reason_code" | "decided_by">;
    };

type RefundRow = Omit<RefundView, "refund_id"> & { refund_id: string };

const COLUMNS = "refund_id, order_id, currency, amount_minor, decision, reason_code, decided_by, reason, note, charged_minor";

const refuse = (
  status: 404 | 409,
  error: RefusalCode,
  extra: { remaining_minor?: number; remaining_currency?: string; refund?: RefundRow } = {},
): HumanDecisionResult => ({
  ok: false,
  status,
  error,
  ...(extra.remaining_minor !== undefined ? { remaining_minor: extra.remaining_minor, remaining_currency: extra.remaining_currency } : {}),
  ...(extra.refund ? { refund: { decision: extra.refund.decision, reason_code: extra.refund.reason_code, decided_by: extra.refund.decided_by } } : {}),
});

/**
 * A human approves or rejects ONE queued refund, in one transaction, under the same per-order lock the webhook
 * pipeline uses. Nothing is paid twice: the state is read again under the lock, so two people approving at the
 * same moment, or one person clicking twice, get one 200 and the rest 409.
 *
 * Approve, in this order: the order must not be cancelled; the amount must still fit the order's balance
 * (POLICY.md section 7, otherwise it stays queued). A refund in another currency than its order is converted
 * into the order's currency at the fixed rates, and that converted amount is what is checked and counted
 * (charged_minor). Only when a currency has no rate is the approval refused: nothing can be computed.
 * A human approval does not re-check the 30-day window, the 20 EUR limit or the reason: a human may approve any
 * queued refund. Reject has no checks except that the refund is queued.
 */
export async function decideByHuman(refundId: string, action: HumanAction): Promise<HumanDecisionResult> {
  if (refundId.length === 0 || refundId.length > 100) return refuse(404, "unknown_refund");

  return withTransaction(async (client): Promise<HumanDecisionResult> => {
    // Which order is it? Read without a lock, then lock that order, then read the refund again.
    const first = await client.query<{ order_id: string }>("SELECT order_id FROM refunds WHERE refund_id = $1", [refundId]);
    if (first.rowCount === 0) return refuse(404, "unknown_refund");
    const orderId = first.rows[0]!.order_id;

    await lockOrder(client, orderId);

    const current = await client.query<RefundRow>(`SELECT ${COLUMNS} FROM refunds WHERE refund_id = $1 FOR UPDATE`, [refundId]);
    const refund = current.rows[0]!;
    if (refund.decision === "parked") return refuse(409, "not_queued", { refund });
    if (refund.decision !== "queued") return refuse(409, "already_decided", { refund });

    const order = await loadOrderState(client, orderId);
    if (order === null) return refuse(409, "order_unknown");
    const amountMinor = Number(refund.amount_minor);

    const approve = action === "approve";
    let chargedMinor: number | null = null;
    if (approve) {
      if (order.cancelledAt !== null) return refuse(409, "order_cancelled");
      chargedMinor = convertMinor(amountMinor, refund.currency, order.currency);
      if (chargedMinor === null) return refuse(409, "no_exchange_rate");
      const remaining = order.totalMinor - order.refundedMinor;
      if (chargedMinor > remaining) return refuse(409, "exceeds_balance", { remaining_minor: remaining, remaining_currency: order.currency });
    }

    const updated = await client.query<RefundRow>(
      `UPDATE refunds SET decision = $2::text, reason_code = $3, decided_by = 'human', decided_at = now(), charged_minor = $4::bigint
       WHERE refund_id = $1 AND decision = 'queued' RETURNING ${COLUMNS}`,
      [refundId, approve ? "approved" : "rejected", approve ? "HUMAN_APPROVED" : "HUMAN_REJECTED", chargedMinor],
    );
    let refundedMinor = order.refundedMinor;
    if (chargedMinor !== null) {
      refundedMinor += chargedMinor;
      await client.query("UPDATE orders SET refunded_minor = $2 WHERE order_id = $1", [orderId, refundedMinor]);
    }

    const row = updated.rows[0]!;
    return {
      ok: true,
      refund: { ...row, amount_minor: Number(row.amount_minor), charged_minor: row.charged_minor === null ? null : Number(row.charged_minor) },
      order: {
        order_id: orderId,
        currency: order.currency,
        total_minor: order.totalMinor,
        refunded_minor: refundedMinor,
        remaining_minor: order.totalMinor - refundedMinor,
      },
    };
  });
}
