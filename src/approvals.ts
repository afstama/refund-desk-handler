import type { FastifyInstance } from "fastify";
import { bearerToken, tokenMatches } from "./auth.js";
import { getConfig } from "./config.js";
import { decideByHuman, type HumanAction, type HumanDecisionResult } from "./decisions.js";

export interface ApprovalDeps {
  decide: (refundId: string, action: HumanAction) => Promise<HumanDecisionResult>;
}

/**
 * POST /refunds/:refund_id/approve and /reject (CONTRACT.md).
 *   401 missing or wrong token. Checked BEFORE the refund is looked up, so a caller without the token
 *       cannot learn which refund ids exist (Marko agreed on 404 for unknown ids, behind the token).
 *   404 unknown refund, 409 already decided / not queued / cancelled / currency / no longer fits, 200 done.
 *   503 only when the database is unreachable.
 */
export function approvalRoutes(deps: ApprovalDeps) {
  return async (scope: FastifyInstance) => {
    // The body is not used. Without this, Fastify answers 400 to "Content-Type: application/json" with an empty
    // body, which is exactly what a browser or a script sends when it has nothing to say. Registered in this
    // plugin only. Anything bigger than 1 KiB is refused with 413.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 1024 }, (_req, _body, done) => done(null, undefined));

    for (const action of ["approve", "reject"] as const) {
      scope.post<{ Params: { refund_id: string } }>(`/refunds/:refund_id/${action}`, { bodyLimit: 1024 }, async (req, reply) => {
        if (!tokenMatches(getConfig().APPROVER_TOKEN, bearerToken(req.headers.authorization))) {
          return reply.code(401).header("www-authenticate", 'Bearer realm="refund-desk"').send({ error: "unauthorized" });
        }
        try {
          const result = await deps.decide(req.params.refund_id, action);
          if (result.ok) return reply.code(200).send(result);
          const { ok: _ok, status, ...body } = result;
          return reply.code(status).send(body);
        } catch (err) {
          req.log.error({ reason: err instanceof Error ? err.message : String(err) }, "could not decide the refund");
          return reply.code(503).send({ error: "temporarily_unavailable" });
        }
      });
    }
  };
}

export { decideByHuman };
