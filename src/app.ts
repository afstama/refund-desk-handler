import Fastify from "fastify";
import { getPool } from "./db.js";

export function buildApp(opts: { logger?: boolean } = {}) {
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

  return app;
}
