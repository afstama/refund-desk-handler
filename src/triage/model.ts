import type { TriageOutput } from "./schema.js";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

/** What one call to the model came back with. The usage is what the provider billed for it. */
export type ModelAnswer =
  | { kind: "ok"; output: TriageOutput; usage: Usage }
  /** The model answered, but not in the shape asked for (or with an empty draft). */
  | { kind: "invalid"; usage: Usage | null; detail: string }
  /** The model declined (a safety stop). Asking again would not change that. */
  | { kind: "refusal"; usage: Usage | null };

/**
 * A call that did not come back with an answer.
 *   fatal: the same request would fail for every message (bad key, bad model name, no credit): stop and wait
 *   retryable: try this message again after a pause (rate limit, overload, network)
 *   neither: this message cannot be triaged
 */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly fatal: boolean = false,
    readonly retryAfterMs?: number,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

/** One call. Implementations: src/triage/anthropic.ts (real) and the fakes of the tests. */
export type TriageModel = (input: { messageId: string; channel: string; text: string }) => Promise<ModelAnswer>;
