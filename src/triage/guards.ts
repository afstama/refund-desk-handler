// The rules that decide whether a reply may leave. Pure functions: no database, no network, no model.
//
// The model proposes (category, flag, draft). THESE rules dispose. The same function runs in the worker before a
// reply is sent and again inside POST /outbound, so a bug in one place cannot send what the other would hold.
//
// POLICY.md section 8: no automated reply to a message about a refund (category refund_related) until a human has
// looked at it. The rules below add what the brief and Marko's answers ask for around it:
//   - a message flagged injection_suspected never gets an automatic reply, whatever its category
//   - a message the model did not read in full (cut) never gets one
//   - a draft that mentions a refund or an approval, or promises money, is never sent (Ana's decision)
//   - if triage failed there is nothing to send

export type HeldReason = "injection_suspected" | "refund_related" | "cut" | "draft_check" | "triage_failed";

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
}

/** Why this message must be held, or null when the reply may be sent automatically. */
export function holdReason(m: ReplyCandidate): HeldReason | null {
  if (m.flags.includes("injection_suspected")) return "injection_suspected";
  if (m.category === "refund_related") return "refund_related";
  if (m.truncated) return "cut";
  if (m.category === null || m.draft === null) return "triage_failed";
  if (draftProblem(m.draft) !== null) return "draft_check";
  return null;
}
