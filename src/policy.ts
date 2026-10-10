// The refund policy from POLICY.md as one pure function: no database, no clock, no I/O.
// Every comparison is in whole minor units, and time comes from the events, never from the server.
import { CURRENCY_DIGITS, DEFAULT_MINOR_UNIT_DIGITS, minorUnitDigits } from "./currency.js";

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

// The numbers of POLICY.md and of Marko's answers. They live here and nowhere else: the screen is told them by
// GET /policy (see policySummary) instead of repeating them in its own text.
export const WINDOW_DAYS = 30;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;
export const AUTO_LIMIT_MINOR = 2000; // 20.00 EUR, in EUR cents
export const AUTO_LIMIT_CURRENCY = "EUR";
export const ELIGIBLE_REASONS = ["damaged", "wrong_item", "not_received", "missing_item"] as const;
const ELIGIBLE_SET: ReadonlySet<string> = new Set(ELIGIBLE_REASONS);

/**
 * Fixed rates: EUR per ONE unit of the currency, in millionths of a EUR (an integer, so no floats).
 * Marko: 1 USD = 0.92 EUR, 1 GBP = 1.17 EUR. A Map, so "constructor" is just an unknown currency.
 * A currency can be added here whatever its decimals: the conversion below takes them from currency.ts.
 */
export const EUR_MICRO_RATES: ReadonlyMap<string, number> = new Map([
  ["EUR", 1_000_000],
  ["USD", 920_000],
  ["GBP", 1_170_000],
]);

/**
 * The amount in EUR cents, rounded half up, with integers only (BigInt, so a large amount cannot lose precision).
 * null for a currency we have no rate for. `rates` is a parameter only so that tests can try other currencies.
 */
export function toEurMinor(amountMinor: number, currency: string, rates: ReadonlyMap<string, number> = EUR_MICRO_RATES): number | null {
  const micro = rates.get(currency);
  if (micro === undefined) return null;
  // EUR cents = amountMinor / 10^digits (major units) * micro / 10^6 (EUR) * 100 (cents)
  const denominator = 10n ** BigInt(minorUnitDigits(currency) + 4);
  return Number((BigInt(amountMinor) * BigInt(micro) * 2n + denominator) / (denominator * 2n));
}

/**
 * An amount in one currency expressed in another, through EUR at the fixed rates, rounded half up once.
 * It is what an approval of a refund in another currency counts against the order's balance.
 * null when either currency has no rate. Never less than 1: a refund must not be counted as nothing.
 */
export function convertMinor(amountMinor: number, from: string, to: string, rates: ReadonlyMap<string, number> = EUR_MICRO_RATES): number | null {
  if (from === to) return amountMinor;
  const fromMicro = rates.get(from);
  const toMicro = rates.get(to);
  if (fromMicro === undefined || toMicro === undefined) return null;
  // major(from) = a / 10^df ; EUR = major * fromMicro / 1e6 ; major(to) = EUR * 1e6 / toMicro ; minor(to) = major(to) * 10^dt
  const numerator = BigInt(amountMinor) * BigInt(fromMicro) * 10n ** BigInt(minorUnitDigits(to));
  const denominator = BigInt(toMicro) * 10n ** BigInt(minorUnitDigits(from));
  const rounded = Number((numerator * 2n + denominator) / (denominator * 2n));
  return Math.max(1, rounded);
}

/** What the screen needs to word its explanations, so that no number is typed in two places. */
export function policySummary() {
  return {
    auto_approve: {
      window_days: WINDOW_DAYS,
      limit_minor: AUTO_LIMIT_MINOR,
      limit_currency: AUTO_LIMIT_CURRENCY,
      eligible_reasons: [...ELIGIBLE_REASONS],
    },
    eur_per_unit_micro: Object.fromEntries(EUR_MICRO_RATES),
    currency_digits: { ...CURRENCY_DIGITS, default: DEFAULT_MINOR_UNIT_DIGITS } as Record<string, number>,
  };
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
  const underThreshold = eurMinor <= AUTO_LIMIT_MINOR;
  const eligibleReason = ELIGIBLE_SET.has(refund.reason);

  if (delivered && withinWindow && underThreshold && eligibleReason) return decided("auto_approved", "AUTO_OK");

  if (!delivered) return forHuman("NOT_DELIVERED");
  if (!withinWindow) return forHuman("WINDOW_EXPIRED");
  if (!underThreshold) return forHuman("OVER_THRESHOLD");
  return forHuman("REASON_NOT_ELIGIBLE");
}
