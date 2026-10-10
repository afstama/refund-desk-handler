// The logic of the approval screen. No DOM and no network, so it is tested from Node (test/view.test.ts).
// Everything here returns plain strings and plain objects: the page puts them in with textContent only.
//
// `policy` is what GET /policy returned (the numbers of the refund policy, the fixed rates and the decimals of
// each currency). It is optional: without it the wording stays correct, only less specific.
// This file does no currency arithmetic: the converted amounts come from the service (GET /queue).

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

/** A fixed rate given in millionths of a EUR per unit: 920000 -> "0.92", 1000000 -> "1". */
export function formatRate(micro) {
  if (!Number.isSafeInteger(micro) || micro < 0) return "?";
  const whole = Math.floor(micro / 1_000_000);
  const fraction = String(micro % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
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

function rateSentence(currencies, policy) {
  const table = policy && policy.eur_per_unit_micro;
  if (!table) return null;
  const parts = [...new Set(currencies)].filter((c) => c !== "EUR" && Object.hasOwn(table, c)).map((c) => `1 ${c} = ${formatRate(table[c])} EUR`);
  return parts.length ? `the fixed rates (${parts.join(", ")})` : null;
}

function nullable(value) {
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Turns the queue into what the screen lists: every queued refund, grouped by order, with the order's numbers,
 * the converted amounts when the currencies are mixed, and the things worth a notice before Approve is clicked.
 * The server decides; a warning only says what it will probably answer.
 */
export function buildQueue(data, policy) {
  const orders = data && data.orders ? data.orders : {};
  const refunds = data && data.refunds ? data.refunds : {};

  const queued = Object.entries(refunds)
    .filter(([, r]) => r.decision === "queued")
    .map(([id, r]) => ({ id, ...r }))
    .sort((a, b) => (a.order_id < b.order_id ? -1 : a.order_id > b.order_id ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const groups = [];
  for (const r of queued) {
    let group = groups[groups.length - 1];
    if (!group || group.orderId !== r.order_id) {
      group = { orderId: r.order_id, order: Object.hasOwn(orders, r.order_id) ? orders[r.order_id] : null, refunds: [] };
      groups.push(group);
    }
    group.refunds.push(r);
  }

  return {
    count: queued.length,
    groups: groups.map((g) => {
      const o = g.order;
      // "mixed": some refund here is in another currency than its order. Then everything is also shown in EUR.
      const mixed = o !== null && g.refunds.some((r) => r.currency !== o.currency);
      const remaining = o ? o.total_minor - o.refunded_minor : null;
      return {
        orderId: g.orderId,
        mixed,
        order: o ? { status: o.status, currency: o.currency, total_minor: o.total_minor, refunded_minor: o.refunded_minor, remaining_minor: remaining } : null,
        summary: o ? orderSummary(o, remaining, mixed, policy) : "not in the queue's data",
        refunds: g.refunds.map((r) => refundView(r, o, remaining, mixed, policy)),
      };
    }),
  };
}

function inEur(minor, eurMinor, currency, policy) {
  return currency !== "EUR" && nullable(eurMinor) !== null ? ` (≈ ${formatMoney(eurMinor, "EUR", policy)})` : "";
}

function orderSummary(o, remaining, mixed, policy) {
  const eur = (minor, eurMinor) => (mixed ? inEur(minor, eurMinor, o.currency, policy) : "");
  return [
    o.status,
    `total ${formatMoney(o.total_minor, o.currency, policy)}${eur(o.total_minor, o.total_eur_minor)}`,
    `refunded ${formatMoney(o.refunded_minor, o.currency, policy)}${eur(o.refunded_minor, o.refunded_eur_minor)}`,
    `still refundable ${formatMoney(remaining, o.currency, policy)}${eur(remaining, o.remaining_eur_minor)}`,
  ].join(" · ");
}

function refundView(r, order, remaining, mixed, policy) {
  const differs = order !== null && r.currency !== order.currency;
  const asOrder = differs ? nullable(r.in_order_currency_minor) : r.amount_minor;
  const lines = [];
  const notices = [];
  const warnings = [];

  if (mixed && r.currency !== "EUR" && nullable(r.eur_minor) !== null) {
    lines.push(["In EUR", `≈ ${formatMoney(r.eur_minor, "EUR", policy)}`]);
  }
  if (differs && asOrder !== null) {
    lines.push(["If approved", `counts as ${formatMoney(asOrder, order.currency, policy)} against the order`]);
  }

  if (!order) {
    warnings.push("This order is not in the queue's data.");
  } else {
    if (order.status === "cancelled") warnings.push("This order was cancelled. Approving will be refused; you can still reject it.");
    if (differs) {
      if (asOrder === null) {
        warnings.push(`There is no exchange rate between ${r.currency} and ${order.currency}, so this cannot be approved here. You can still reject it.`);
      } else {
        const rates = rateSentence([r.currency, order.currency], policy);
        notices.push(
          `The refund is in ${r.currency} but the order is in ${order.currency}. ` +
            (rates ? `Amounts are converted at ${rates}, rounded to the smallest unit. ` : "Amounts are converted at fixed rates. ") +
            "Approve only if this is right.",
        );
        if (asOrder > remaining) {
          warnings.push(
            `Approving would count ${formatMoney(asOrder, order.currency, policy)} against the order, but only ${formatMoney(remaining, order.currency, policy)} is still refundable. Approving will be refused unless that changes.`,
          );
        }
      }
    } else if (r.amount_minor > remaining) {
      warnings.push(`Only ${formatMoney(remaining, order.currency, policy)} of this order is still refundable. Approving will be refused unless that changes.`);
    }
  }

  return {
    id: r.id,
    order_id: r.order_id,
    currency: r.currency,
    amount_minor: r.amount_minor,
    order_currency: order ? order.currency : null,
    counted_minor: differs ? asOrder : null,
    reason: r.reason,
    reason_code: r.reason_code,
    note: r.note ?? null,
    explanation: explain(r, policy),
    lines,
    notices,
    warnings,
  };
}

/** The label of the second click that confirms an approval. */
export function confirmLabel(refund, policy) {
  const amount = formatMoney(refund.amount_minor, refund.currency, policy);
  if (refund.order_currency && refund.order_currency !== refund.currency && Number.isSafeInteger(refund.counted_minor)) {
    return `Confirm approve ${amount} (counts as ${formatMoney(refund.counted_minor, refund.order_currency, policy)})?`;
  }
  return `Confirm approve ${amount}?`;
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
      case "no_exchange_rate":
        return "There is no exchange rate between this refund's currency and the order's, so it cannot be approved here. You can still reject it.";
      case "exceeds_balance":
        return `Not approved: it no longer fits. Only ${formatMoney(body.remaining_minor, body.remaining_currency || currency, policy)} of this order is still refundable. The refund stays queued; you can reject it.`;
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
  const own = formatMoney(r.amount_minor, r.currency, policy);
  if (action === "approve") {
    const orderCurrency = result.order.currency || r.currency;
    const counted = orderCurrency !== r.currency && Number.isSafeInteger(r.charged_minor) ? ` (counted as ${formatMoney(r.charged_minor, orderCurrency, policy)})` : "";
    return `Approved ${r.refund_id}: ${own}${counted}. ${formatMoney(result.order.remaining_minor, orderCurrency, policy)} of order ${r.order_id} is still refundable.`;
  }
  return `Rejected ${r.refund_id}: ${own}. Nothing was paid.`;
}
