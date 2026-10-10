import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getConfig } from "./config.js";
import { withTransaction } from "./db.js";
import { holdReason } from "./triage/guards.js";
import { OUTBOUND_SIGNATURE_HEADER, outboundSignatureMatches } from "./triage/outboundAuth.js";

// POST /outbound: this service's own fake "send reply" endpoint (CONTRACT.md). It records what was "sent".
//
// Two locks, so that nothing can make a held draft look sent:
//   1. the call must carry a signature made with a key derived from WEBHOOK_SECRET (only our own worker has it)
//   2. the endpoint decides again, from the stored triage result, whether this message may be answered
//      automatically. A message that must be held is refused here whatever the caller says.
// A message is answered at most once: a second call is acknowledged and records nothing.
//
//   200 {status: "sent" | "already_sent"}   401 bad or missing signature   400 body not understood
//   404 unknown message   409 {error: "held", reason} / {error: "not_triaged"} / {error: "text_mismatch"}

const BODY_LIMIT = 64 * 1024;

const Body = z.object({ message_id: z.string().min(1).max(200), text: z.string().min(1).max(2000) }).strict();

function single(header: string | string[] | undefined): string | undefined {
  return typeof header === "string" ? header : undefined;
}

export function outboundRoutes() {
  return async (scope: FastifyInstance) => {
    // The signature covers the exact bytes: keep the body as a Buffer. Registered in this plugin only.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: BODY_LIMIT }, (_req, body, done) => done(null, body));

    scope.post("/outbound", { bodyLimit: BODY_LIMIT }, async (req, reply) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!outboundSignatureMatches(getConfig().WEBHOOK_SECRET, raw, single(req.headers[OUTBOUND_SIGNATURE_HEADER]))) {
        return reply.code(401).send({ error: "unauthorized" });
      }

      let parsed;
      try {
        parsed = Body.safeParse(JSON.parse(raw.toString("utf8")));
      } catch {
        return reply.code(400).send({ error: "invalid_body" });
      }
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const { message_id: messageId, text } = parsed.data;

      try {
        const outcome = await withTransaction(async (client) => {
          const found = await client.query<{
            triage_status: string;
            held_reason: string | null;
            category: string | null;
            flags: string[];
            truncated: boolean;
            draft_reply: string | null;
            auto_reply_sent: boolean;
            text: string;
          }>(
            `SELECT triage_status, held_reason, category, flags, truncated, draft_reply, auto_reply_sent, text
             FROM messages WHERE message_id = $1 FOR UPDATE`,
            [messageId],
          );
          const m = found.rows[0];
          if (!m) return { code: 404, body: { error: "unknown_message" } };
          if (m.auto_reply_sent) return { code: 200, body: { status: "already_sent" } };
          if (m.triage_status !== "done") return { code: 409, body: { error: "not_triaged" } };

          // the stored reason AND the rules again: if either says hold, nothing is recorded
          const reason =
            m.held_reason ?? holdReason({ category: m.category, flags: m.flags, truncated: m.truncated, draft: m.draft_reply, text: m.text });
          if (reason !== null) return { code: 409, body: { error: "held", reason } };
          if (text !== m.draft_reply) return { code: 409, body: { error: "text_mismatch" } };

          await client.query("INSERT INTO outbound_log (message_id, text) VALUES ($1, $2)", [messageId, text]);
          await client.query("UPDATE messages SET auto_reply_sent = true WHERE message_id = $1", [messageId]);
          return { code: 200, body: { status: "sent" } };
        });
        return reply.code(outcome.code).send(outcome.body);
      } catch (err) {
        req.log.error({ reason: err instanceof Error ? err.message : String(err) }, "outbound: could not record the reply");
        return reply.code(503).send({ error: "temporarily_unavailable" });
      }
    });
  };
}
