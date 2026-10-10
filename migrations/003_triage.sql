-- Phase 7: triage of customer messages, the fake "send reply" endpoint, and the bookkeeping of what the model costs.
-- Nothing here touches orders or refunds: a message never changes a refund (POLICY.md section 1).

-- Why a finished message was NOT answered automatically. NULL means "answer it" (or "already answered").
-- Priority when several apply: injection_suspected, refund_related, cut, draft_check.
ALTER TABLE messages
  ADD COLUMN held_reason text CHECK (held_reason IN ('injection_suspected', 'refund_related', 'cut', 'draft_check', 'triage_failed')),
  -- the model saw only the start and the end of the text (src/triage/prepare.ts)
  ADD COLUMN truncated boolean NOT NULL DEFAULT false,
  ADD COLUMN triaged_at timestamptz,
  ADD COLUMN model text;

-- A finished triage has its three results.
ALTER TABLE messages ADD CONSTRAINT messages_done_has_result
  CHECK (triage_status <> 'done' OR (category IS NOT NULL AND sentiment IS NOT NULL AND draft_reply IS NOT NULL));

-- The rule of POLICY.md section 8 as a database fact: a reply is marked sent only for a message that may be answered.
-- (The code decides first; this makes a bug or a forged call unable to write the opposite.)
ALTER TABLE messages ADD CONSTRAINT messages_sent_only_when_allowed
  CHECK (NOT auto_reply_sent OR (
    triage_status = 'done'
    AND held_reason IS NULL
    AND category IS DISTINCT FROM 'refund_related'
    AND NOT ('injection_suspected' = ANY (flags))
    AND NOT truncated
  ));

-- One row per reply that "left the building". The key is the message: a message is answered at most once.
CREATE TABLE outbound_log (
  message_id text PRIMARY KEY REFERENCES messages (message_id),
  text       text NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now()
);

-- One row per call that the model answered (and so was billed), including retried and refused ones.
-- The spend guard adds these up, so the total survives restarts.
CREATE TABLE model_calls (
  id            bigserial PRIMARY KEY,
  message_id    text NOT NULL REFERENCES messages (message_id),
  model         text NOT NULL,
  input_tokens  integer NOT NULL CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL CHECK (output_tokens >= 0),
  outcome       text NOT NULL CHECK (outcome IN ('ok', 'invalid', 'refusal')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_calls_message_idx ON model_calls (message_id);
