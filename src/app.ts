import Fastify from "fastify";
import { applyEvent } from "./apply.js";
import { approvalRoutes, decideByHuman, type ApprovalDeps } from "./approvals.js";
import { getPool } from "./db.js";
import { readLedger } from "./ledger.js";
import { webhookRoutes, type WebhookDeps } from "./webhooks.js";

export function buildApp(opts: { logger?: boolean; apply?: WebhookDeps["apply"]; decide?: ApprovalDeps["decide"] } = {}) {
  // POST /webhooks/ must work as well as POST /webhooks: a sender that adds a slash must not get a 404.
  const app = Fastify({ logger: opts.logger ?? false, ignoreTrailingSlash: true });

  app.get("/health", async (_req, reply) => {
    try {
      await getPool().query("SELECT 1");
      return { ok: true, db: true };
    } catch (err) {
      app.log.error({ msg: err instanceof Error ? err.message : String(err) }, "health check: database unreachable");
      return reply.code(503).send({ ok: false, db: false });
    }
  });

  // Public by contract: only approve and reject need the bearer token. It holds no email and no message text.
  app.get("/ledger", async (_req, reply) => {
    try {
      const ledger = await readLedger();
      // no-store: nothing in front of the service may show an old ledger
      return reply.header("cache-control", "no-store").send(ledger);
    } catch (err) {
      app.log.error({ msg: err instanceof Error ? err.message : String(err) }, "ledger: could not read the database");
      return reply.code(503).send({ error: "temporarily_unavailable" });
    }
  });

  app.register(webhookRoutes({ apply: opts.apply ?? applyEvent }));
  app.register(approvalRoutes({ decide: opts.decide ?? decideByHuman }));

  return app;
}
