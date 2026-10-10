import { z } from "zod";

// The values of CONTRACT.md. The same lists are in the database CHECKs (migrations/001_init.sql).
export const CATEGORIES = ["order_status", "product_question", "complaint", "praise", "refund_related", "other"] as const;
export const SENTIMENTS = ["positive", "neutral", "negative"] as const;

export type Category = (typeof CATEGORIES)[number];
export type Sentiment = (typeof SENTIMENTS)[number];

/** What the model must answer. Nothing in it can change a refund: it is four plain values. */
export const TriageOutput = z.object({
  category: z.enum(CATEGORIES),
  sentiment: z.enum(SENTIMENTS),
  draft_reply: z.string(),
  injection_suspected: z.boolean(),
});
export type TriageOutput = z.infer<typeof TriageOutput>;

export const DRAFT_MAX_CHARS = 300;

/**
 * The draft is one line: whitespace and control characters become single spaces, and it is cut at DRAFT_MAX_CHARS.
 * Returns null when nothing is left (a model answer with an empty draft is not usable).
 */
export function normalizeDraft(draft: string): string | null {
  const oneLine = draft.replace(/[\p{Cc}\s]+/gu, " ").trim();
  if (!oneLine) return null;
  const points = Array.from(oneLine);
  return points.length <= DRAFT_MAX_CHARS ? oneLine : points.slice(0, DRAFT_MAX_CHARS).join("").trimEnd();
}

/** The `flags` of the ledger. Only the model's suspicion is a flag. */
export function flagsFor(output: Pick<TriageOutput, "injection_suspected">): string[] {
  return output.injection_suspected ? ["injection_suspected"] : [];
}
