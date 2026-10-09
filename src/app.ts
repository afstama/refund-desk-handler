import Fastify from "fastify";
import { applyEvent } from "./apply.js";
import { getPool } from "./db.js";
import { webhookRoutes, type WebhookDeps } from "./webhooks.js";

export function buildApp(opts: { logger?: boolean; apply?: WebhookDeps["apply"] } = {}) {
  const app = Fastify({ logger: opts.logger ?? false });

  app.get("/health", async (_req, reply) => {
    try {
      await getPool().query("SELECT 1");
      return { ok: true, db: true };
    } catch (err) {
      app.log.error({ msg: err instanceof Error ? err.message : String(err) }, "health check: database unreachable");
      return reply.code(503).send({ ok: false, db: false });
    }
  });

  app.register(webhookRoutes({ apply: opts.apply ?? applyEvent }));

  return app;
}
