// The logic of the approval screen. No DOM and no network, so it is tested from Node (test/view.test.ts).
// Everything here returns plain strings and plain objects: the page puts them in with textContent only.
//
// `policy` is what GET /policy returned (the numbers of the refund policy and the decimals of each currency).
// It is optional: without it the wording stays correct, only less specific, so no number is typed in this file.

function digitsFor(currency, policy) {
  const table = policy && policy.currency_digits;
  if (table && Object.hasOwn(table, currency) && Number.isInteger(table[currency])) return table[currency];
  return table && Number.isInteger(table.default) ? table.default : 2;
}

/** Whole minor units to text, with integers only: 3500 EUR -> "35.00 EUR", 1500 JPY -> "1500 JPY". */
export function formatMoney(minor, currency, policy) {
  if (!Number.isSafeInteger(minor)) return `? ${currency}`;
  const digits = digitsFor(currency, policy);
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const scale = 10 ** digits;
  const whole = Math.floor(abs / scale);
  const fraction = digits > 0 ? `.${String(abs % scale).padStart(digits, "0")}` : "";
  return `${sign}${whole}${fraction} ${currency}`;
}

function limitText(policy) {
  const a = policy && policy.auto_approve;
  return a ? formatMoney(a.limit_minor, a.limit_currency, policy) : null;
}

/** Why the policy could not decide this refund, in words. */
export function explain(refund, policy) {
  const a = policy && policy.auto_approve;
  switch (refund.reason_code) {
    case "NOT_DELIVERED":
      return "No delivery is recorded for this order.";
    case "WINDOW_EXPIRED":
      return a ? `It was requested more than ${a.window_days} days after delivery.` : "It was requested after the delivery window.";
    case "OVER_THRESHOLD": {
      if (refund.note === "currency_mismatch") return "The refund is in a different currency than the order, so the policy cannot compare it.";
      const limit = limitText(policy);
      if (refund.note === "unsupported_currency") {
        return limit ? `This currency has no exchange rate, so the policy cannot check the ${limit} limit.` : "This currency has no exchange rate, so the policy cannot check the limit.";
      }
      return limit ? `The amount is over the ${limit} automatic limit.` : "The amount is over the automatic limit.";
    }
    case "REASON_NOT_ELIGIBLE": {
      const list = a && Array.isArray(a.eligible_reasons) ? a.eligible_reasons.map((r) => r.replaceAll("_", " ")).join(", ") : null;
      return list ? `The customer's reason is not one of the automatic ones (${list}).` : "The customer's reason is not one of the automatic ones.";
    }
    default:
      return `Held for a person to decide (${refund.reason_code}).`;
  }
}

/**
 * Turns the ledger into what the screen lists: every queued refund, grouped by order, with the order's numbers
 * and the things worth a warning before Approve is clicked. The server decides; a warning only says what it
 * will probably answer.
 */
export function buildQueue(ledger, policy) {
  const orders = ledger && ledger.orders ? ledger.orders : {};
  const refunds = ledger && ledger.refunds ? ledger.refunds : {};

  const queued = Object.entries(refunds)
    .filter(([, r]) => r.decision === "queued")
    .map(([id, r]) => ({ id, ...r }))
    .sort((a, b) => (a.order_id < b.order_id ? -1 : a.order_id > b.order_id ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const groups = [];
  for (const r of queued) {
    let group = groups[groups.length - 1];
    if (!group || group.orderId !== r.order_id) {
      const o = Object.hasOwn(orders, r.order_id) ? orders[r.order_id] : null;
      group = {
        orderId: r.order_id,
        order: o
          ? { status: o.status, currency: o.currency, total_minor: o.total_minor, refunded_minor: o.refunded_minor, remaining_minor: o.total_minor - o.refunded_minor }
          : null,
        refunds: [],
      };
      groups.push(group);
    }
    group.refunds.push({
      id: r.id,
      order_id: r.order_id,
      currency: r.currency,
      amount_minor: r.amount_minor,
      reason: r.reason,
      reason_code: r.reason_code,
      note: r.note ?? null,
      explanation: explain(r, policy),
      warnings: warningsFor(r, group.order, policy),
    });
  }
  return { count: queued.length, groups };
}

function warningsFor(refund, order, policy) {
  if (!order) return ["This order is not in the ledger."];
  const warnings = [];
  if (order.status === "cancelled") warnings.push("This order was cancelled. Approving will be refused; you can still reject it.");
  if (refund.currency !== order.currency) {
    warnings.push(`The refund is in ${refund.currency} but the order is in ${order.currency}. Approving is refused for now; you can still reject it.`);
  } else if (refund.amount_minor > order.remaining_minor) {
    warnings.push(`Only ${formatMoney(order.remaining_minor, order.currency, policy)} of this order is still refundable. Approving will be refused unless that changes.`);
  }
  return warnings;
}

/** The label of the second click that confirms an approval. */
export function confirmLabel(refund, policy) {
  return `Confirm approve ${formatMoney(refund.amount_minor, refund.currency, policy)}?`;
}

/** What the service answered when it refused, in words. */
export function describeRefusal(status, body, currency, policy) {
  const error = body && typeof body === "object" ? body.error : undefined;
  if (status === 401) return "Sign in again.";
  if (status === 404) return "This refund no longer exists.";
  if (status === 503) return "The service could not reach its database. Try again in a moment.";
  if (status === 409) {
    switch (error) {
      case "already_decided": {
        const decision = body.refund && body.refund.decision ? body.refund.decision : "decided";
        return `Already ${decision}. Nothing was changed.`;
      }
      case "not_queued":
        return "This refund is waiting for its order and cannot be decided yet.";
      case "order_cancelled":
        return "The order was cancelled meanwhile, so it cannot be approved. You can still reject it.";
      case "currency_mismatch":
        return "The refund is in a different currency than the order, so it cannot be approved for now. You can still reject it.";
      case "exceeds_balance":
        return `No longer fits: only ${formatMoney(body.remaining_minor, currency, policy)} of this order is still refundable. The refund stays queued.`;
      default:
        return `Refused (${error ?? "conflict"}).`;
    }
  }
  return `Unexpected answer (${status}).`;
}

/** What to say when the service accepted the decision. */
export function describeSuccess(action, result, policy) {
  const r = result && result.refund;
  if (!r || !result.order) return action === "approve" ? "Approved." : "Rejected.";
  if (action === "approve") {
    return `Approved ${r.refund_id}: ${formatMoney(r.amount_minor, r.currency, policy)}. ${formatMoney(result.order.remaining_minor, r.currency, policy)} of order ${r.order_id} is still refundable.`;
  }
  return `Rejected ${r.refund_id}: ${formatMoney(r.amount_minor, r.currency, policy)}. Nothing was paid.`;
}
