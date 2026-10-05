# Contract

Everything here is exact. Our replay tool and our ledger comparison depend on it.

## Endpoints you expose

| Method and path | Purpose | Responses |
|---|---|---|
| `POST /webhooks` | Receive one event | `2xx` accepted (including duplicates and unknown types) · `401` bad signature · `400` body is not valid JSON |
| `GET /ledger` | Current state | `200` with the JSON below |
| `POST /refunds/:refund_id/approve` | Human approves a queued refund | `200` · `401` missing or wrong token · `409` already decided, or no longer fits the balance |
| `POST /refunds/:refund_id/reject` | Human rejects a queued refund | `200` · `401` · `409` already decided |
| `POST /outbound` | Your own fake "send reply" endpoint | `200`, record what was sent |
| `GET /` | The approval screen | — |

Approve and reject need the header `Authorization: Bearer <APPROVER_TOKEN>`.

## Incoming webhook

Headers:

```
Content-Type: application/json
X-Event-Id: evt_0193
X-Signature: sha256=<hex>
```

`X-Signature` is HMAC-SHA256 of the **raw request body bytes**, keyed with `WEBHOOK_SECRET`, hex encoded. Compute it over the bytes exactly as they arrive.

Body:

```json
{ "id": "evt_0193", "type": "refund.requested", "occurred_at": "2026-04-14T09:12:44+02:00", "payload": { } }
```

`occurred_at` is RFC 3339 and always carries an offset. Offsets vary between events.

## How a line of `events.ndjson` becomes a request

Each line is one delivery:

```json
{ "event_id": "evt_0193", "signature": "sha256=…", "body": "<the exact request body, as a string>" }
```

We send `body` byte for byte as the request body, `event_id` as `X-Event-Id`, and `signature` as `X-Signature`. Bodies are not all formatted the same way.

## Event types and payloads

| Type | Payload |
|---|---|
| `order.created` | `{ "order_id": "O-1042", "customer_email": "…", "total": "29.97", "currency": "EUR" }` |
| `shipment.delivered` | `{ "order_id": "O-1042" }` |
| `order.cancelled` | `{ "order_id": "O-1042" }` |
| `refund.requested` | `{ "refund_id": "R-0311", "order_id": "O-1042", "amount": "9.99", "currency": "EUR", "reason": "damaged" }` |
| `message.received` | `{ "message_id": "M-0207", "order_id": "O-1042" or null, "channel": "email", "text": "…" }` |

Amounts are decimal strings in the given `currency` (ISO 4217). Other event types exist in production and can show up. Acknowledge them with `2xx` and count them.

## Delivery guarantees (what disorder to expect)

- **Duplicates:** any event can be delivered more than once. A redelivery has the same `id` and an identical body. Count it, change nothing.
- **Order:** an `order.created` can arrive late, after events that refer to it. That is the only reordering. Everything else about one order arrives in `occurred_at` order.
- **Retries:** our sender waits 3 seconds. On timeout or non-2xx it resends the identical body, up to 3 times.

## The ledger

`GET /ledger` returns at least this shape. You may add fields; do not rename or remove any. All money is integer minor units (cents, pence) in the record's own currency.

```json
{
  "orders": {
    "O-1042": { "status": "created | delivered | cancelled", "currency": "EUR", "total_minor": 2997, "refunded_minor": 999 }
  },
  "refunds": {
    "R-0311": {
      "order_id": "O-1042",
      "currency": "EUR",
      "amount_minor": 999,
      "decision": "auto_approved | queued | approved | rejected | parked",
      "reason_code": "AUTO_OK | NOT_DELIVERED | WINDOW_EXPIRED | OVER_THRESHOLD | REASON_NOT_ELIGIBLE | ORDER_CANCELLED | EXCEEDS_BALANCE | ORDER_UNKNOWN | HUMAN_APPROVED | HUMAN_REJECTED",
      "decided_by": "policy | human | none"
    }
  },
  "messages": {
    "M-0207": {
      "category": "order_status | product_question | complaint | praise | refund_related | other",
      "sentiment": "positive | neutral | negative",
      "draft_reply": "one line",
      "flags": ["injection_suspected"],
      "auto_reply_sent": true
    }
  },
  "dead_letter": [ { "event_id": "evt_0044", "reason": "bad_signature | invalid_json" } ],
  "duplicates_ignored": 0,
  "unknown_types_acked": 0
}
```

Notes:

- `refunded_minor` is the sum of approved refunds on that order (automatic and human).
- `duplicates_ignored` counts redeliveries of events you had already accepted. Deliveries you refused with `401` or `400` are never counted, however often they are retried.
- `dead_letter` lists each refused event once per reason, with the id from the `X-Event-Id` header.
- `decided_by` is `none` while a refund is `queued` or `parked`.
- `flags` is an empty array when there is nothing to flag.
- Messages still being processed by Claude may be missing from `messages` for a short while. We wait 3 minutes after the last event before we read the ledger.
- `category`, `sentiment` and `draft_reply` come from the model, so we read a sample by hand. Everything else we compare exactly.
