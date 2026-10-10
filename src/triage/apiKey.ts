/**
 * Does this look like an Anthropic API key at all? Only the shape: it says nothing about whether the key works.
 * Used to say "the key is not a key" in plain words (npm run check-env, the trial script, the start-up log) instead of
 * a stream of refused calls. Settings validation stays lenient on purpose: tests and local development run with any
 * non-empty value.
 */
export function looksLikeAnthropicKey(value: string): boolean {
  return value.startsWith("sk-ant-") && value.length >= 30 && !/\s/.test(value);
}
