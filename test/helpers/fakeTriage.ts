// Fakes for the triage worker: an in-memory store, a clock that only moves when somebody sleeps, and a scripted model.
// Nothing here talks to the network or to the model. The real model is only ever built in src/triage/start.ts.
import { ModelError, type ModelAnswer, type TriageModel, type Usage } from "../../src/triage/model.js";
import type { Sender, SendResult } from "../../src/triage/sender.js";
import type { DueReply, PendingMessage, TriageResult, TriageStore } from "../../src/triage/store.js";

export interface Clock {
  t: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** Time passes only through `sleep`, so a test that "waits 60 seconds" takes no time at all. */
export function fakeClock(start = 1_000_000): Clock {
  const clock: Clock = {
    t: start,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += Math.max(0, ms);
    },
  };
  return clock;
}

export interface FakeMessage {
  message_id: string;
  channel: string;
  text: string;
  triage_attempts: number;
  status: "pending" | "done" | "failed";
  result: TriageResult | null;
  sent: boolean;
}

export interface FakeStore extends TriageStore {
  messages: Map<string, FakeMessage>;
  calls: { messageId: string; model: string; usage: Usage; outcome: string }[];
  /** Makes the next recordCall throw (the database failing after the model answered). */
  failNextRecord: boolean;
}

export function fakeStore(texts: Record<string, string> | [string, string][] = {}): FakeStore {
  const entries = Array.isArray(texts) ? texts : Object.entries(texts);
  const messages = new Map<string, FakeMessage>(
    entries.map(([id, text]) => [id, { message_id: id, channel: "email", text, triage_attempts: 0, status: "pending", result: null, sent: false }]),
  );
  const store: FakeStore = {
    messages,
    calls: [],
    failNextRecord: false,
    async nextPending(limit, exclude) {
      return [...messages.values()]
        .filter((m) => m.status === "pending" && !exclude.includes(m.message_id))
        .slice(0, limit)
        .map<PendingMessage>((m) => ({ message_id: m.message_id, channel: m.channel, text: m.text, triage_attempts: m.triage_attempts }));
    },
    async recordCall(messageId, model, usage, outcome) {
      if (store.failNextRecord) {
        store.failNextRecord = false;
        throw new Error("database is down");
      }
      store.calls.push({ messageId, model, usage, outcome });
    },
    async bumpAttempts(messageId) {
      const m = messages.get(messageId)!;
      m.triage_attempts += 1;
      return m.triage_attempts;
    },
    async finish(messageId, result) {
      const m = messages.get(messageId)!;
      if (m.status !== "pending") return false;
      m.status = "done";
      m.result = result;
      return true;
    },
    async fail(messageId) {
      const m = messages.get(messageId)!;
      if (m.status !== "pending") return false;
      m.status = "failed";
      return true;
    },
    async repliesDue(limit, exclude) {
      return [...messages.values()]
        .filter((m) => m.status === "done" && m.result?.held === null && !m.sent && !exclude.includes(m.message_id))
        .slice(0, limit)
        .map<DueReply>((m) => ({ message_id: m.message_id, draft_reply: m.result!.draft }));
    },
  };
  return store;
}

export const ok = (over: Partial<{ category: string; sentiment: string; draft_reply: string; injection_suspected: boolean }> = {}, usage: Usage = { input_tokens: 600, output_tokens: 60 }): ModelAnswer => ({
  kind: "ok",
  output: {
    category: "product_question",
    sentiment: "neutral",
    draft_reply: "Thank you for your message, our team will get back to you.",
    injection_suspected: false,
    ...over,
  } as never,
  usage,
});

export const invalid = (detail = "not JSON", usage: Usage | null = { input_tokens: 600, output_tokens: 20 }): ModelAnswer => ({ kind: "invalid", usage, detail });
export const refusal = (usage: Usage | null = { input_tokens: 600, output_tokens: 0 }): ModelAnswer => ({ kind: "refusal", usage });

type Step = ModelAnswer | ModelError | ((input: { messageId: string; channel: string; text: string }) => ModelAnswer | Promise<ModelAnswer>);

/**
 * A model that answers from a script: `script[messageId]` is a list of steps used in order (the last one repeats).
 * A message with no script gets `fallback`.
 */
export function scriptedModel(script: Record<string, Step[]> = {}, fallback: Step = ok()) {
  const seen: { messageId: string; channel: string; text: string }[] = [];
  const counts = new Map<string, number>();
  const model: TriageModel = async (input) => {
    seen.push(input);
    const steps = script[input.messageId];
    const n = counts.get(input.messageId) ?? 0;
    counts.set(input.messageId, n + 1);
    const step = steps ? steps[Math.min(n, steps.length - 1)]! : fallback;
    if (step instanceof ModelError) throw step;
    return typeof step === "function" ? step(input) : step;
  };
  return { model, seen, counts };
}

/** A sender that records the calls and (like /outbound would) marks the message as answered in the fake store. */
export function fakeSender(store: FakeStore, results: SendResult[] = []): Sender & { sent: { messageId: string; text: string }[] } {
  const sent: { messageId: string; text: string }[] = [];
  const fn: Sender = async (messageId, text) => {
    const result = results.shift() ?? { ok: true, status: "sent" as const };
    if (result.ok) {
      sent.push({ messageId, text });
      store.messages.get(messageId)!.sent = true;
    }
    return result;
  };
  return Object.assign(fn, { sent });
}
