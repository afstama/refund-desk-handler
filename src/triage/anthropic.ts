import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { ModelError, type ModelAnswer, type TriageModel } from "./model.js";
import { userContent, SYSTEM_PROMPT } from "./prompt.js";
import { TriageOutput } from "./schema.js";

// Room for the answer (about 80 tokens) and for any thinking the model does before it. If it ran out, the answer
// would be cut and unusable.
const MAX_TOKENS = 1024;
const TIMEOUT_MS = 30_000;
const MAX_RETRY_AFTER_MS = 60_000;

/** Sorts an SDK error into what the worker should do about it (see ModelError). Never includes a key or the text. */
export function classifyError(err: unknown): ModelError {
  if (err instanceof Anthropic.APIConnectionError) return new ModelError(`${err.name}: no answer from the API`, true);
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    if (status === 429) {
      const seconds = Number(err.headers?.get?.("retry-after"));
      const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : undefined;
      return new ModelError("rate limited (429)", true, false, retryAfterMs, 429);
    }
    if (typeof status === "number" && status >= 500) return new ModelError(`provider error (${status})`, true, false, undefined, status);
    // 400 (also "credit balance too low"), 401, 403, 404 (no such model): the same request fails for every message
    if (status === 400 || status === 401 || status === 403 || status === 404 || status === 422) {
      return new ModelError(`request refused by the API (${status}): ${err.message}`, false, true, undefined, status);
    }
    return new ModelError(`API error (${status ?? "no status"})`, true, false, undefined, status);
  }
  return new ModelError(err instanceof Error ? err.name : "unknown error", true);
}

/**
 * The real model. The SDK does no retrying of its own (maxRetries 0): the worker owns the pauses and the count,
 * so the rate limit and the spend guard see every call.
 *
 * The answer is requested in a fixed JSON shape (structured output) and then checked again with the same Zod schema.
 * No tools are given: the model can only write the four fields of TriageOutput.
 * Effort is `low`: this is a classification. Thinking is left at the model's default (adaptive), because turning it off
 * is allowed on some models and refused on others and this code must work for the ones in src/triage/pricing.ts.
 */
export function createAnthropicModel(opts: { apiKey: string; model: string; client?: Anthropic }): TriageModel {
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 0, timeout: TIMEOUT_MS });
  const format = zodOutputFormat(TriageOutput);

  return async (input): Promise<ModelAnswer> => {
    let response;
    try {
      response = await client.messages.create({
        model: opts.model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent(input) }],
        output_config: { format, effort: "low" },
      });
    } catch (err) {
      throw classifyError(err);
    }

    const usage = { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens };
    if (response.stop_reason === "refusal") return { kind: "refusal", usage };
    if (response.stop_reason === "max_tokens") return { kind: "invalid", usage, detail: "the answer was cut at max_tokens" };

    const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { kind: "invalid", usage, detail: "the answer is not JSON" };
    }
    const parsed = TriageOutput.safeParse(value);
    if (!parsed.success) return { kind: "invalid", usage, detail: "the answer does not have the requested shape" };
    return { kind: "ok", output: parsed.data, usage };
  };
}
