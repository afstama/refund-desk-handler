// What the model gets to read of a customer message.
//
// A message up to MAX_WHOLE_CHARS is sent whole. A longer one is sent as its first and its last KEEP_EACH_END
// characters with a marker in between, so one message is never more than MAX_WHOLE_CHARS (about 5,000 tokens).
// The end is kept because the point of a long text is often there: in the data, M-0063 is one sentence repeated
// for 124,000 characters and its real question is the last sentence.
// A message that was cut never gets an automatic reply (src/triage/guards.ts): nobody read all of it.

export const MAX_WHOLE_CHARS = 20_000;
export const KEEP_EACH_END = 10_000;

export interface PreparedText {
  text: string;
  truncated: boolean;
  /** Characters left out (0 when the text is whole). */
  omitted: number;
}

/** Counts and cuts by Unicode code points, so a cut never splits an emoji in half. */
export function prepareText(text: string): PreparedText {
  // length counts UTF-16 units, which is never less than the number of characters: cheap exit for the normal case
  if (text.length <= MAX_WHOLE_CHARS) return { text, truncated: false, omitted: 0 };
  const points = Array.from(text);
  if (points.length <= MAX_WHOLE_CHARS) return { text, truncated: false, omitted: 0 };
  const omitted = points.length - 2 * KEEP_EACH_END;
  const head = points.slice(0, KEEP_EACH_END).join("");
  const tail = points.slice(points.length - KEEP_EACH_END).join("");
  return { text: `${head}\n[... ${omitted} characters omitted ...]\n${tail}`, truncated: true, omitted };
}
