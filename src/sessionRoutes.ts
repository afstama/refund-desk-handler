import type { FastifyInstance, FastifyRequest } from "fastify";
import { authenticate, isSecureRequest, tokenMatches } from "./auth.js";
import { getConfig } from "./config.js";
import type { Queue } from "./ledger.js";
import { clearedCookie, issueSession, sessionCookie } from "./session.js";

export interface SessionDeps {
  readQueue: () => Promise<Queue>;
}

const secure = (req: FastifyRequest) => isSecureRequest(req.protocol, process.env.NODE_ENV);

/**
 * The login of the approval screen.
 *   POST /login   {token} -> 204 and the session cookie. Every failure is the same 401, whatever went wrong.
 *   POST /logout  -> 204, the cookie is cleared in this browser.
 *   GET  /queue   -> the queued refunds and their orders. Private: a session or the Bearer header.
 * GET /ledger stays public because the contract and Qure's tool need it.
 */
export function sessionRoutes(deps: SessionDeps) {
  return async (scope: FastifyInstance) => {
    // A body that is not JSON must not give a different answer from a wrong token: parse it ourselves, never throw.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "string", bodyLimit: 1024 }, (_req, body, done) => {
      try {
        done(null, JSON.parse(String(body)));
      } catch {
        done(null, undefined);
      }
    });

    scope.post("/login", { bodyLimit: 1024 }, async (req, reply) => {
      const given = (req.body as { token?: unknown } | null | undefined)?.token;
      if (typeof given !== "string" || !tokenMatches(getConfig().APPROVER_TOKEN, given)) {
        return reply.code(401).header("cache-control", "no-store").send({ error: "unauthorized" });
      }
      const { value, maxAge } = issueSession(getConfig().APPROVER_TOKEN);
      return reply.code(204).header("cache-control", "no-store").header("set-cookie", sessionCookie(value, maxAge, secure(req))).send();
    });

    scope.post("/logout", async (req, reply) => {
      return reply.code(204).header("cache-control", "no-store").header("set-cookie", clearedCookie(secure(req))).send();
    });

    scope.get("/queue", async (req, reply) => {
      if (!authenticate(req.headers, getConfig().APPROVER_TOKEN, secure(req))) {
        return reply.code(401).header("cache-control", "no-store").send({ error: "unauthorized" });
      }
      try {
        return reply.header("cache-control", "no-store").send(await deps.readQueue());
      } catch (err) {
        req.log.error({ reason: err instanceof Error ? err.message : String(err) }, "could not read the queue");
        return reply.code(503).send({ error: "temporarily_unavailable" });
      }
    });
  };
}
