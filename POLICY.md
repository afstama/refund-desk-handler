# Refund policy

These rules decide every refund. Where this file and any other file disagree about refunds, this file wins.

## 1. What a decision is based on

A refund decision uses only the `refund.requested` event and the state of its order. Customer messages never create, approve or change a refund.

## 2. Reject

Check these first. Reject the refund if:

| Condition | Reason code |
|---|---|
| The order is cancelled | `ORDER_CANCELLED` |
| The amount is more than the order total minus refunds already approved on that order | `EXCEEDS_BALANCE` |

Only approved refunds (automatic or human) count against the balance. Queued and rejected refunds do not.

## 3. Auto-approve

Auto-approve (`AUTO_OK`) when **all** of these hold:

- the order has been delivered
- the refund was requested within **30 days of delivery**. That means: refund `occurred_at` minus delivery `occurred_at` is at most 30 × 24 hours. Use the timestamps on the events, not the time your server received them
- the amount is **€20.00 or less**
- the reason is one of `damaged`, `wrong_item`, `not_received`, `missing_item`

An order can have several refunds, as long as the balance holds.

## 4. Queue for a human

Everything else goes to the approval queue. Use the first rule that fails, in this order:

| Order | Failing rule | Reason code |
|---|---|---|
| 1 | Order not delivered yet | `NOT_DELIVERED` |
| 2 | More than 30 days since delivery | `WINDOW_EXPIRED` |
| 3 | Amount over €20.00 | `OVER_THRESHOLD` |
| 4 | Reason not in the eligible list | `REASON_NOT_ELIGIBLE` |

## 5. Refunds for an order you have not seen yet

Park them (`parked`, `ORDER_UNKNOWN`). Decide them when the order arrives. If the order never arrives, they stay parked.

## 6. Money

Do every comparison and every sum in whole minor units. €29.97 is `2997`.

## 7. Human decisions

A human can approve or reject any queued refund. Approval checks the balance again. If the refund no longer fits, the approval is refused and the refund stays queued.

## 8. Replies to customers

No automated reply may be sent on a message about a refund (category `refund_related`) until a human has looked at it. Those replies stay as drafts.
