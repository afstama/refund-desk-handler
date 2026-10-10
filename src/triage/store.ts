import type pg from "pg";
import { getPool } from "../db.js";
import type { HeldReason } from "./guards.js";
import type { Usage } from "./model.js";

// The only tables this module reads or writes: messages, model_calls (and outbound_log through src/outbound.ts).
// Nothing here can reach orders or refunds: a message never changes a refund (POLICY.md section 1).

export interface PendingMessage {
  message_id: string;
  channel: string;
  text: string;
  triage_attempts: number;
}

export interface DueReply {
  message_id: string;
  draft_reply: string;
}

export interface TriageResult {
  category: string;
  sentiment: string;
  draft: string;
  flags: string[];
  truncated: boolean;
  held: HeldReason | null;
  model: string;
}

export interface TriageStore {
  /** Oldest first. `exclude` are the messages that are being worked on or are cooling down. */
  nextPending(limit: number, exclude: readonly string[]): Promise<PendingMessage[]>;
  /** One row per answered call, so the spend guard can add it up. */
  recordCall(messageId: string, model: string, usage: Usage, outcome: "ok" | "invalid" | "refusal"): Promise<void>;
  /** Counts a failed attempt and returns how many there are now. */
  bumpAttempts(messageId: string): Promise<number>;
  /** Stores the result. False when the message was not pending any more (someone else finished it). */
  finish(messageId: string, result: TriageResult): Promise<boolean>;
  /** Gives up on a message: it stays out of the ledger and gets no reply. */
  fail(messageId: string): Promise<boolean>;
  /** Finished messages that may be answered and have not been (a send that failed earlier). */
  repliesDue(limit: number, exclude: readonly string[]): Promise<DueReply[]>;
}

export function createPgStore(pool: pg.Pool = getPool()): TriageStore {
  return {
    async nextPending(limit, exclude) {
      const res = await pool.query<PendingMessage>(
        `SELECT message_id, channel, text, triage_attempts FROM messages
         WHERE triage_status = 'pending' AND NOT (message_id = ANY($2::text[]))
         ORDER BY occurred_at, message_id LIMIT $1`,
        [limit, exclude],
      );
      return res.rows;
    },

    async recordCall(messageId, model, usage, outcome) {
      await pool.query(
        "INSERT INTO model_calls (message_id, model, input_tokens, output_tokens, outcome) VALUES ($1, $2, $3, $4, $5)",
        [messageId, model, usage.input_tokens, usage.output_tokens, outcome],
      );
    },

    async bumpAttempts(messageId) {
      const res = await pool.query<{ triage_attempts: number }>(
        "UPDATE messages SET triage_attempts = triage_attempts + 1 WHERE message_id = $1 RETURNING triage_attempts",
        [messageId],
      );
      return res.rows[0]?.triage_attempts ?? 0;
    },

    async finish(messageId, r) {
      const res = await pool.query(
        `UPDATE messages SET triage_status = 'done', category = $2, sentiment = $3, draft_reply = $4, flags = $5::text[],
                truncated = $6, held_reason = $7, model = $8, triaged_at = now()
         WHERE message_id = $1 AND triage_status = 'pending'`,
        [messageId, r.category, r.sentiment, r.draft, r.flags, r.truncated, r.held, r.model],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async fail(messageId) {
      const res = await pool.query(
        `UPDATE messages SET triage_status = 'failed', held_reason = 'triage_failed', triaged_at = now()
         WHERE message_id = $1 AND triage_status = 'pending'`,
        [messageId],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async repliesDue(limit, exclude) {
      const res = await pool.query<DueReply>(
        `SELECT message_id, draft_reply FROM messages
         WHERE triage_status = 'done' AND held_reason IS NULL AND NOT auto_reply_sent
           AND NOT (message_id = ANY($2::text[]))
         ORDER BY occurred_at, message_id LIMIT $1`,
        [limit, exclude],
      );
      return res.rows;
    },
  };
}
