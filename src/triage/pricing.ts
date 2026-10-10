// What a model call costs, to add up what the service has spent (src/triage/budget.ts).
// US dollars per million tokens, written as whole micro-dollars so nothing here is a float.
// Source: the price table of the Claude API skill, cached 2026-10-06. Haiku 5.5 is $0.10 / $0.50 for prompts up to
// 100K tokens ($0.50 / $2.50 beyond); a message here is never more than about 6,000 tokens (src/triage/prepare.ts).
// A model that is not in this table is refused at start-up: the guard cannot count what it cannot price.
// Only models that accept `output_config.effort` belong here (src/triage/anthropic.ts sends it): not Haiku 4.5.

interface Price {
  /** micro-dollars per million input tokens */
  input: number;
  /** micro-dollars per million output tokens */
  output: number;
}

export const PRICES: Readonly<Record<string, Price>> = {
  "claude-haiku-5-5": { input: 100_000, output: 500_000 },
  "claude-sonnet-5-5": { input: 2_000_000, output: 10_000_000 },
  "claude-opus-5-5": { input: 4_000_000, output: 20_000_000 },
};

export function hasPrice(model: string): boolean {
  return Object.hasOwn(PRICES, model);
}

const MOST_EXPENSIVE: Price = { input: 4_000_000, output: 20_000_000 };

/** Micro-dollars for these tokens, rounded up. An unknown model is counted at the highest price in the table. */
export function costMicros(model: string, inputTokens: number, outputTokens: number): number {
  const p = hasPrice(model) ? PRICES[model]! : MOST_EXPENSIVE;
  return Math.ceil((inputTokens * p.input + outputTokens * p.output) / 1_000_000);
}

export function usdToMicros(usd: number): number {
  return Math.round(usd * 1_000_000);
}

export function microsToUsd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`;
}
