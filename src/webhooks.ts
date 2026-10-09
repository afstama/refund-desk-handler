import type { FastifyInstance } from "fastify";
import { type ApplyInput, type ApplyStatus } from "./apply.js";
import { getConfig } from "./config.js";
import { recordDeadLetter } from "./deadLetter.js";
import { classify, type Classified } from "./events.js";
import { signatureMatches } from "./signature.js";

// The biggest body in events.ndjson is 125 KB. Fastify's default limit is 1 MiB.
const BODY_LIMIT = 2 * 1024 * 1024;

export interface WebhookDeps {
  apply: (input: ApplyInput) => Promise<{ status: ApplyStatus }>;
}

function single(header: string | string[] | undefined): string | undefined {
  return typeof header === "string" ? header : undefined;
}

function readJson(raw: Buffer): { ok: true; text: string; value: unknown } | { ok: false } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    return { ok: true, text, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function safeClassify(value: unknown): Classified {
  try {
    return classify(value);
  } catch {
    // classify is built not to throw. If an odd input still gets through, refuse that event rather than crash.
    return { ok: false, detail: "event could not be read" };
  }
}

/**
 * POST /webhooks, in this order: signature, JSON, shape, then duplicate check and apply in one transaction.
 *   401 bad signature, 400 body is not JSON (both fixed by CONTRACT.md, both listed in dead_letter)
 *   200 everything else: accepted, duplicate, unknown type, or a signed but invalid event (dead_lettered)
 *   503 only when we could not store the event (database down): the sender retries, nothing is lost
 */
export function webhookRoutes(deps: WebhookDeps) {
  return async (scope: FastifyInstance) => {
    // The signature covers the exact bytes, so keep the body as a Buffer for every content type.
    // Registered inside this plugin only: other routes keep Fastify's normal parsers.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: BODY_LIMIT }, (_req, body, done) => done(null, body));

    scope.post("/webhooks", { bodyLimit: BODY_LIMIT }, async (req, reply) => {
      const eventId = single(req.headers["x-event-id"]);
      if (!eventId || eventId.length > 128) return reply.code(400).send({ error: "missing_event_id" });
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      try {
        if (!signatureMatches(getConfig().WEBHOOK_SECRET, raw, single(req.headers["x-signature"]))) {
          await recordDeadLetter(eventId, "bad_signature", "signature does not match");
          return reply.code(401).send({ error: "bad_signature" });
        }

        const json = readJson(raw);
        if (!json.ok) {
          await recordDeadLetter(eventId, "invalid_json", "body is not valid JSON");
          return reply.code(400).send({ error: "invalid_json" });
        }

        const classified = safeClassify(json.value);
        if (!classified.ok) {
          await recordDeadLetter(eventId, "invalid_event", classified.detail);
          return reply.code(200).send({ status: "dead_lettered" });
        }

        const result = await deps.apply({ eventId, raw, text: json.text, event: classified.event });
        return reply.code(200).send({ status: result.status });
      } catch (err) {
        req.log.error({ reason: err instanceof Error ? err.message : String(err) }, "could not store event, asking the sender to retry");
        return reply.code(503).send({ error: "temporarily_unavailable" });
      }
    });
  };
}
