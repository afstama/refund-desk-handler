// The rules that decide whether a reply may leave. Pure functions: no database, no network, no model.
//
// The model proposes (category, flag, draft). THESE rules dispose. The same function runs in the worker before a
// reply is sent and again inside POST /outbound, so a bug in one place cannot send what the other would hold.
//
// POLICY.md section 8: no automated reply to a message about a refund (category refund_related) until a human has
// looked at it. The rules below add what the brief and Marko's answers ask for around it:
//   - a message flagged injection_suspected never gets an automatic reply, whatever its category
//   - a message whose own text has refund words is held like a refund_related one, whatever category the model
//     chose (Ana's decision: the model's category for a borderline message changes from one run to the next)
//   - a message the model did not read in full (cut) never gets one
//   - a draft that mentions a refund or an approval, or promises money, is never sent (Ana's decision)
//   - if triage failed there is nothing to send

export type HeldReason = "injection_suspected" | "refund_related" | "cut" | "draft_check" | "triage_failed";

/**
 * Words in the CUSTOMER'S text that make a message a refund message for the reply rule (Marko: "even partly about
 * a refund"). The wide list, on purpose: a false hold costs one human look, a missed one sends an unchecked answer
 * about money. On the 83 messages of events.ndjson it holds all 20 refund messages of the answer key and one more
 * (M-0068, "send mine back"). The category in the ledger stays the model's; only the reply is held.
 */
const REFUND_TEXT_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "refund", pattern: /refund/iu },
  { name: "money back", pattern: /\bmoney[\s-]*back\b/iu },
  { name: "chargeback", pattern: /\bcharge[\s-]*back/iu },
  { name: "reimburse", pattern: /\breimburs/iu },
  { name: "compensation", pattern: /\bcompensat/iu },
  { name: "charge", pattern: /\b(?:over)?charg(?:e|ed|es|ing)\b/iu },
  { name: "reversal", pattern: /\brevers(?:e|ed|al|ing)\b/iu },
  { name: "return", pattern: /\breturn(?:s|ed|ing)?\b/iu },
  { name: "send back", pattern: /\bsen[dt](?:ing)?\s+(?:\S+\s+){0,2}back\b/iu },
];

/** The first refund word found in a customer's text, or null. Looks at the whole text, also of a message that was cut. */
export function refundWords(text: string): string | null {
  for (const { name, pattern } of REFUND_TEXT_PATTERNS) if (pattern.test(text)) return name;
  return null;
}

/** What a draft must not say. A false hold costs one human look; a wrong reply costs a promise we did not make. */
const DRAFT_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "refund", pattern: /\brefund/iu },
  { name: "money back", pattern: /\bmoney[\s-]*back\b/iu },
  { name: "reimburse", pattern: /\breimburs/iu },
  { name: "compensation", pattern: /\bcompensat/iu },
  { name: "approval", pattern: /\bapprov/iu },
  { name: "credit", pattern: /\bcredit(?:ed|s|ing)?\b/iu },
  { name: "paying back", pattern: /\brepa(?:y|id|yment)|\bpa(?:y|id|ying)\s+(?:you\s+)?back\b/iu },
  { name: "chargeback", pattern: /\bcharge[\s-]*back/iu },
  { name: "value promise", pattern: /\b(?:discount|voucher|coupon|gift\s*card)\b/iu },
  // an amount: a currency sign next to a digit, or a digit followed by a currency name
  { name: "amount", pattern: /[€$£]\s*\d|\d[\d.,]*\s*(?:[€$£]|eur(?:os?)?\b|usd\b|dollars?\b|gbp\b|pounds?\b)/iu },
];

/**
 * What the ledger shows instead of a draft that fails the check (Ana's decision): a message whose draft promises
 * or mentions a refund, an approval or money is held, and its draft_reply is this line, so the public ledger never
 * shows a promise. What the model wrote is kept in messages.original_draft. It passes the check itself (tested).
 */
export const NEUTRAL_DRAFT = "Thank you for your message. Our team will review it and get back to you.";

/** The first thing wrong with a draft, or null when it promises nothing. */
export function draftProblem(draft: string): string | null {
  for (const { name, pattern } of DRAFT_PATTERNS) if (pattern.test(draft)) return name;
  return null;
}

export interface ReplyCandidate {
  category: string | null;
  flags: readonly string[];
  truncated: boolean;
  draft: string | null;
  /** The customer's whole text. Required, so that no caller can decide without the check on it. */
  text: string;
}

/** Why this message must be held, or null when the reply may be sent automatically. */
export function holdReason(m: ReplyCandidate): HeldReason | null {
  if (m.flags.includes("injection_suspected")) return "injection_suspected";
  if (m.category === "refund_related" || refundWords(m.text) !== null) return "refund_related";
  if (m.truncated) return "cut";
  if (m.category === null || m.draft === null) return "triage_failed";
  if (draftProblem(m.draft) !== null) return "draft_check";
  return null;
}
