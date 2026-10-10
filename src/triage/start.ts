import type { Config } from "../config.js";
import { createAnthropicModel } from "./anthropic.js";
import { looksLikeAnthropicKey } from "./apiKey.js";
import { createBudget } from "./budget.js";
import { createRateLimiter } from "./limiter.js";
import { hasPrice, microsToUsd, usdToMicros } from "./pricing.js";
import { createHttpSender } from "./sender.js";
import { createPgStore } from "./store.js";
import { createWorker, type Logger, type Worker } from "./worker.js";

/**
 * Builds the real worker, or returns null (and says why) when triage must not run.
 * The model is called only when TRIAGE_LIVE is "1": a local replay or a test run never spends anything, and the
 * messages simply stay pending (the ledger lists a message only after its triage).
 */
export function startTriage(config: Config, log: Logger): Worker | null {
  if (!config.TRIAGE_LIVE) {
    log.info({}, "triage is off (TRIAGE_LIVE is not 1): messages are stored and stay pending, the model is not called");
    return null;
  }
  if (!hasPrice(config.TRIAGE_MODEL)) {
    // Without a price the spend guard cannot count. The rest of the service keeps working.
    log.error({ model: config.TRIAGE_MODEL }, "triage is off: TRIAGE_MODEL has no price in src/triage/pricing.ts");
    return null;
  }

  if (!looksLikeAnthropicKey(config.ANTHROPIC_API_KEY)) {
    // Not fatal (the shape is a guess), but it says in plain words what a stream of 401 refusals would otherwise say.
    log.warn({}, "ANTHROPIC_API_KEY does not look like an Anthropic key (it should start with sk-ant-): the model calls will probably be refused");
  }

  const outboundUrl = config.OUTBOUND_URL ?? `http://127.0.0.1:${config.PORT}/outbound`;
  const ceiling = usdToMicros(config.TRIAGE_BUDGET_USD);
  log.info(
    { model: config.TRIAGE_MODEL, per_minute: config.TRIAGE_PER_MINUTE, concurrency: config.TRIAGE_CONCURRENCY, ceiling: microsToUsd(ceiling) },
    "triage is on",
  );

  return createWorker({
    model: createAnthropicModel({ apiKey: config.ANTHROPIC_API_KEY, model: config.TRIAGE_MODEL }),
    modelName: config.TRIAGE_MODEL,
    store: createPgStore(),
    send: createHttpSender({ url: outboundUrl, secret: config.WEBHOOK_SECRET }),
    budget: createBudget(ceiling),
    limiter: createRateLimiter({ perMinute: config.TRIAGE_PER_MINUTE }),
    concurrency: config.TRIAGE_CONCURRENCY,
    log,
  });
}
