-- Refund Desk, first schema.
-- Money is bigint minor units. Times are timestamptz (instants).
-- Until the first deploy this file may be edited and the dev branch reset.
-- After the first deploy, only add new numbered files.

-- One row per accepted unique event (signature and JSON valid, well-formed).
-- The primary key is the duplicate check.
--   duplicates_ignored  = SUM(redeliveries)
--   unknown_types_acked = COUNT(*) WHERE outcome = 'unknown_type'
CREATE TABLE events (
  event_id     text PRIMARY KEY,
  body_sha256  text NOT NULL,
  body         text NOT NULL,
  type         text NOT NULL,
  outcome      text NOT NULL CHECK (outcome IN ('applied', 'unknown_type')),
  occurred_at  timestamptz,
  redeliveries integer NOT NULL DEFAULT 0 CHECK (redeliveries >= 0),
  received_at  timestamptz NOT NULL DEFAULT now()
);

-- Refused events. Once per event per reason. Refused bodies are not stored.
CREATE TABLE dead_letter (
  id         bigserial PRIMARY KEY,
  event_id   text NOT NULL,
  reason     text NOT NULL,
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, reason)
);

-- Rows come only from order.created.
-- CHECK (refunded_minor <= total_minor) is the database backstop for "never paid twice".
CREATE TABLE orders (
  order_id       text PRIMARY KEY,
  customer_email text,
  currency       text NOT NULL,
  total_minor    bigint NOT NULL CHECK (total_minor >= 0),
  refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  created_at     timestamptz NOT NULL,
  event_id       text NOT NULL REFERENCES events (event_id),
  CHECK (refunded_minor <= total_minor)
);

-- Delivered / cancelled facts about an order. No foreign key to orders:
-- a delivery can arrive before its order.created.
CREATE TABLE order_events (
  order_id    text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('delivered', 'cancelled')),
  occurred_at timestamptz NOT NULL,
  event_id    text NOT NULL REFERENCES events (event_id),
  PRIMARY KEY (order_id, kind)
);

-- No foreign key to orders: a parked refund points at an order we have not seen.
-- reason_code has no CHECK yet: the code for R-0075 is still open, so TypeScript enforces it.
CREATE TABLE refunds (
  refund_id    text PRIMARY KEY,
  order_id     text NOT NULL,
  currency     text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  reason       text NOT NULL,
  occurred_at  timestamptz NOT NULL,
  decision     text NOT NULL CHECK (decision IN ('auto_approved', 'queued', 'approved', 'rejected', 'parked')),
  reason_code  text NOT NULL,
  decided_by   text NOT NULL CHECK (decided_by IN ('policy', 'human', 'none')),
  note         text,
  decided_at   timestamptz,
  event_id     text NOT NULL REFERENCES events (event_id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- decided_by is 'none' exactly while the refund is queued or parked
  CHECK ((decided_by = 'none') = (decision IN ('queued', 'parked')))
);
CREATE INDEX refunds_order_idx ON refunds (order_id);
CREATE INDEX refunds_open_idx ON refunds (decision) WHERE decision IN ('queued', 'parked');

-- Phase 2 stores the message, phase 7 fills in the triage result.
CREATE TABLE messages (
  message_id      text PRIMARY KEY,
  order_id        text,
  channel         text NOT NULL,
  text            text NOT NULL,
  occurred_at     timestamptz NOT NULL,
  event_id        text NOT NULL REFERENCES events (event_id),
  triage_status   text NOT NULL DEFAULT 'pending' CHECK (triage_status IN ('pending', 'done', 'failed')),
  triage_attempts integer NOT NULL DEFAULT 0 CHECK (triage_attempts >= 0),
  category        text CHECK (category IN ('order_status', 'product_question', 'complaint', 'praise', 'refund_related', 'other')),
  sentiment       text CHECK (sentiment IN ('positive', 'neutral', 'negative')),
  draft_reply     text,
  flags           text[] NOT NULL DEFAULT '{}',
  auto_reply_sent boolean NOT NULL DEFAULT false
);
CREATE INDEX messages_pending_idx ON messages (occurred_at) WHERE triage_status = 'pending';
