// The refund policy from POLICY.md as one pure function: no database, no clock, no I/O.
// Every comparison is in whole minor units, and time comes from the events, never from the server.

export type RefundDecision = "auto_approved" | "queued" | "rejected" | "parked";
export type ReasonCode =
  | "AUTO_OK"
  | "NOT_DELIVERED"
  | "WINDOW_EXPIRED"
  | "OVER_THRESHOLD"
  | "REASON_NOT_ELIGIBLE"
  | "ORDER_CANCELLED"
  | "EXCEEDS_BALANCE"
  | "ORDER_UNKNOWN";

export interface RefundInput {
  amountMinor: number;
  currency: string;
  /** Already normalised to lower case. */
  reason: string;
  occurredAt: Date;
}

export interface OrderState {
  currency: string;
  totalMinor: number;
  /** Approved refunds so far (automatic and human). Queued and rejected ones do not count. */
  refundedMinor: number;
  deliveredAt: Date | null;
  /** When the cancellation happened (its own timestamp), or null. It only counts for a refund made at or after it. */
  cancelledAt: Date | null;
}

export interface PolicyDecision {
  decision: RefundDecision;
  reasonCode: ReasonCode;
  decidedBy: "policy" | "none";
  /** Why a human has to look, when the contract has no reason code for it. Never part of the decision itself. */
  note: string | null;
}

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const THRESHOLD_EUR_MINOR = 2000;
const ELIGIBLE_REASONS = new Set(["damaged", "wrong_item", "not_received", "missing_item"]);

// Marko's fixed rates as whole percent: 1 USD = 0.92 EUR, 1 GBP = 1.17 EUR. A Map, so "constructor" is just unknown.
const EUR_PERCENT = new Map([
  ["EUR", 100],
  ["USD", 92],
  ["GBP", 117],
]);

/** The amount in EUR cents, rounded half up, with integers only. null for a currency we have no rate for. */
export function toEurMinor(amountMinor: number, currency: string): number | null {
  const percent = EUR_PERCENT.get(currency);
  if (percent === undefined) return null;
  return Math.floor((amountMinor * percent + 50) / 100);
}

const decided = (decision: "auto_approved" | "rejected", reasonCode: ReasonCode): PolicyDecision => ({ decision, reasonCode, decidedBy: "policy", note: null });
const forHuman = (reasonCode: ReasonCode, note: string | null = null): PolicyDecision => ({ decision: "queued", reasonCode, decidedBy: "none", note });

/**
 * Decides one refund against the state of its order. `order` is null when the order has not been seen yet.
 *
 * Order of checks, as in POLICY.md: unknown order, then reject (cancelled, over balance), then auto-approve,
 * then the first failing rule for a human.
 *
 * Decisions that go beyond the text of POLICY.md, all agreed with Ana (HANDOFF.md):
 * - A refund in another currency than its order, or in a currency without a rate, goes to a human. The code
 *   OVER_THRESHOLD plus a note is provisional until Marko answers. The balance cannot be compared across
 *   currencies, so that check is skipped for a mismatch. A cancelled order is still rejected.
 * - "Delivered" means delivered at or before the refund's own timestamp. "Cancelled" is the same: an order counts
 *   as cancelled for a refund only if it was cancelled at or before the refund's own timestamp. So one history of
 *   events gives one decision, whether order.created arrived on time or last (a parked refund is decided later,
 *   when more of the order's events are known).
 */
export function decideRefund(refund: RefundInput, order: OrderState | null): PolicyDecision {
  if (order === null) return { decision: "parked", reasonCode: "ORDER_UNKNOWN", decidedBy: "none", note: null };

  const cancelled = order.cancelledAt !== null && order.cancelledAt.getTime() <= refund.occurredAt.getTime();
  if (cancelled) return decided("rejected", "ORDER_CANCELLED");

  const sameCurrency = refund.currency === order.currency;
  if (!sameCurrency) return forHuman("OVER_THRESHOLD", "currency_mismatch");

  if (refund.amountMinor > order.totalMinor - order.refundedMinor) return decided("rejected", "EXCEEDS_BALANCE");

  const eurMinor = toEurMinor(refund.amountMinor, refund.currency);
  if (eurMinor === null) return forHuman("OVER_THRESHOLD", "unsupported_currency");

  const delivered = order.deliveredAt !== null && order.deliveredAt.getTime() <= refund.occurredAt.getTime();
  const withinWindow = delivered && refund.occurredAt.getTime() - order.deliveredAt!.getTime() <= WINDOW_MS;
  const underThreshold = eurMinor <= THRESHOLD_EUR_MINOR;
  const eligibleReason = ELIGIBLE_REASONS.has(refund.reason);

  if (delivered && withinWindow && underThreshold && eligibleReason) return decided("auto_approved", "AUTO_OK");

  if (!delivered) return forHuman("NOT_DELIVERED");
  if (!withinWindow) return forHuman("WINDOW_EXPIRED");
  if (!underThreshold) return forHuman("OVER_THRESHOLD");
  return forHuman("REASON_NOT_ELIGIBLE");
}
