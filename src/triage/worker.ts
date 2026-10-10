import type { Budget } from "./budget.js";
import { draftProblem, holdReason, NEUTRAL_DRAFT } from "./guards.js";
import type { RateLimiter } from "./limiter.js";
import { ModelError, type ModelAnswer, type TriageModel } from "./model.js";
import { prepareText } from "./prepare.js";
import { flagsFor, normalizeDraft } from "./schema.js";
import type { Sender } from "./sender.js";
import type { PendingMessage, TriageStore } from "./store.js";

// The worker that triages stored messages and sends the replies that may be sent.
//
//   pending message -> model -> (guards) -> stored result -> if allowed: POST /outbound
//
// It reads and writes only messages and the call records. It has no way to touch an order or a refund.
// The webhook never waits for it: a message is stored first, and the worker picks it up from the table, so a
// restart or a model outage loses nothing (the message simply stays pending).

export const MAX_ATTEMPTS = 8;
/**
 * Pause before attempt 2, 3, ... 8: 90 seconds in all. A message is given up for good (it never reaches the ledger),
 * so a short outage of the model must not cost one; and 90 seconds still fit in the 3 minutes the grader waits
 * after the last event. A 429 that names a longer wait wins.
 */
export const BACKOFF_MS: readonly number[] = [1000, 2000, 4000, 8000, 15_000, 30_000, 30_000];
/** After a fatal answer (bad key, no credit, no such model) wait this long before trying one message again. */
export const HALT_MS = 60_000;
const POLL_MS = 5_000;

export interface Logger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

const silent: Logger = { info() {}, warn() {}, error() {} };
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface WorkerDeps {
  model: TriageModel;
  /** Recorded with every call and in the message row. */
  modelName: string;
  store: TriageStore;
  send: Sender;
  budget: Pick<Budget, "allows">;
  limiter: RateLimiter;
  concurrency: number;
  log?: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  backoffMs?: readonly number[];
  haltMs?: number;
}

export interface Worker {
  /** Triage everything that is pending now, send what may be sent, then return. Overlapping kicks are merged. */
  kick(): Promise<void>;
  /** Resumes what was pending and then looks again every few seconds. */
  start(): void;
  stop(): Promise<void>;
}

export function createWorker(deps: WorkerDeps): Worker {
  const log = deps.log ?? silent;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS;
  const backoff = deps.backoffMs ?? BACKOFF_MS;
  const haltMs = deps.haltMs ?? HALT_MS;

  const inFlight = new Set<string>();
  /** message id -> time before which it is not tried again */
  const coolUntil = new Map<string, number>();
  /** replies that could not be sent: id -> time before which it is not tried again (Infinity: given up until restart) */
  const sendCool = new Map<string, number>();
  let haltedUntil = 0;
  let budgetLogged = false;
  let stopped = false;
  let draining: Promise<void> | null = null;
  let again = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  function pause(attempts: number, retryAfterMs?: number): number {
    const own = backoff[Math.min(attempts, backoff.length) - 1] ?? backoff[backoff.length - 1] ?? 1000;
    return Math.max(own, retryAfterMs ?? 0);
  }

  async function trySend(messageId: string, draft: string): Promise<void> {
    const result = await deps.send(messageId, draft);
    if (result.ok) {
      sendCool.delete(messageId);
      return;
    }
    log.warn({ message_id: messageId, detail: result.detail }, "reply not sent");
    sendCool.set(messageId, result.retryable ? now() + 5_000 : Infinity);
  }

  async function sendDue(): Promise<void> {
    const skip = [...sendCool].filter(([, until]) => until > now()).map(([id]) => id);
    for (const due of await deps.store.repliesDue(50, skip)) {
      if (stopped) return;
      await trySend(due.message_id, due.draft_reply);
    }
  }

  /** A failed attempt that is worth repeating: count it, and give up after maxAttempts. */
  async function retryLater(m: PendingMessage, why: string, retryAfterMs?: number): Promise<void> {
    const attempts = await deps.store.bumpAttempts(m.message_id);
    if (attempts >= maxAttempts) {
      await deps.store.fail(m.message_id);
      coolUntil.delete(m.message_id);
      log.warn({ message_id: m.message_id, attempts, why }, "triage given up: the message stays unlisted and gets no reply");
      return;
    }
    coolUntil.set(m.message_id, now() + pause(attempts, retryAfterMs));
    log.info({ message_id: m.message_id, attempts, why }, "triage will be tried again");
  }

  async function onError(m: PendingMessage, e: ModelError): Promise<void> {
    if (e.fatal) {
      // The same request would fail for every message. Do not count it against this one, and do not hammer the API.
      haltedUntil = now() + haltMs;
      log.error({ message_id: m.message_id, status: e.status, detail: e.message }, "triage halted: the model call is refused for every message");
      return;
    }
    if (e.retryable) return retryLater(m, e.message, e.retryAfterMs);
    await deps.store.fail(m.message_id);
    coolUntil.delete(m.message_id);
    log.warn({ message_id: m.message_id, detail: e.message }, "triage given up");
  }

  async function triageOne(m: PendingMessage): Promise<void> {
    coolUntil.delete(m.message_id);
    const prepared = prepareText(m.text);

    let answer: ModelAnswer;
    try {
      answer = await deps.model({ messageId: m.message_id, channel: m.channel, text: prepared.text });
    } catch (err) {
      return onError(m, err instanceof ModelError ? err : new ModelError(err instanceof Error ? err.name : "error", true));
    }

    // billed whatever the content: record it before anything else can fail
    if (answer.usage) await deps.store.recordCall(m.message_id, deps.modelName, answer.usage, answer.kind);

    if (answer.kind === "refusal") {
      await deps.store.fail(m.message_id);
      log.warn({ message_id: m.message_id }, "the model declined this message: it stays unlisted and gets no reply");
      return;
    }
    if (answer.kind === "invalid") return retryLater(m, answer.detail);

    const draft = normalizeDraft(answer.output.draft_reply);
    if (draft === null) return retryLater(m, "empty draft");

    const flags = flagsFor(answer.output);
    // judged on what the model wrote. A draft that fails the check is held AND replaced, so the ledger never shows it.
    // The whole text is checked for refund words, not only the part the model read.
    const held = holdReason({ category: answer.output.category, flags, truncated: prepared.truncated, draft, text: m.text });
    const replaced = draftProblem(draft) !== null;
    const shown = replaced ? NEUTRAL_DRAFT : draft;
    const stored = await deps.store.finish(m.message_id, {
      category: answer.output.category,
      sentiment: answer.output.sentiment,
      draft: shown,
      originalDraft: replaced ? draft : null,
      flags,
      truncated: prepared.truncated,
      held,
      model: deps.modelName,
    });
    if (!stored) {
      // finished by someone else in the meantime. Should it still show as pending, do not ask the model again at once.
      coolUntil.set(m.message_id, now() + pause(1));
      return;
    }
    log.info({ message_id: m.message_id, category: answer.output.category, held, truncated: prepared.truncated }, "triaged");

    if (held === null) await trySend(m.message_id, shown);
  }

  async function triagePending(): Promise<void> {
    const running = new Set<Promise<void>>();
    try {
      for (;;) {
        if (stopped || now() < haltedUntil) break;
        if (running.size >= deps.concurrency) {
          await Promise.race(running);
          continue;
        }
        if (!(await deps.budget.allows())) {
          if (!budgetLogged) log.error({}, "triage stopped: the spend ceiling is reached, messages stay pending");
          budgetLogged = true;
          break;
        }
        budgetLogged = false;

        const t = now();
        const skip = [...inFlight, ...[...coolUntil].filter(([, until]) => until > t).map(([id]) => id)];
        const [next] = await deps.store.nextPending(1, skip);
        if (!next) {
          // nothing can start now: wait for the running calls (they may schedule a retry), or for the earliest pause
          if (running.size > 0) {
            await Promise.race(running);
            continue;
          }
          const waits = [...coolUntil.values()].map((until) => until - now()).filter((ms) => ms > 0);
          if (waits.length === 0) break;
          await sleep(Math.min(...waits));
          continue;
        }

        inFlight.add(next.message_id);
        try {
          await deps.limiter.acquire();
        } catch (err) {
          inFlight.delete(next.message_id);
          throw err;
        }
        if (stopped) {
          inFlight.delete(next.message_id);
          break;
        }
        const job: Promise<void> = triageOne(next)
          .catch((err) => {
            // e.g. the database failed after the model answered. Pause this message: asking again at once would
            // spend again for the same failure.
            coolUntil.set(next.message_id, now() + pause(1));
            log.error({ message_id: next.message_id, detail: err instanceof Error ? err.message : String(err) }, "triage step failed");
          })
          .finally(() => {
            running.delete(job);
            inFlight.delete(next.message_id);
          });
        running.add(job);
      }
    } finally {
      await Promise.allSettled([...running]);
    }
  }

  async function run(): Promise<void> {
    try {
      await sendDue();
      await triagePending();
    } catch (err) {
      // a database hiccup must not stop the loop for good: the next kick tries again
      log.error({ detail: err instanceof Error ? err.message : String(err) }, "triage pass failed");
    }
  }

  function kick(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (draining) {
      again = true;
      return draining;
    }
    const current: Promise<void> = run().finally(() => {
      draining = null;
      if (again && !stopped) {
        again = false;
        void kick();
      }
    });
    draining = current;
    return current;
  }

  return {
    kick,
    start() {
      void kick();
      timer = setInterval(() => void kick(), POLL_MS);
      timer.unref();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      await draining?.catch(() => {});
    },
  };
}
