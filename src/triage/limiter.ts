export interface RateLimiter {
  /** Resolves when one more call may start without passing `perMinute` calls in any 60 second window. */
  acquire(): Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A sliding window: the start times of the last calls are remembered, and a new call waits until fewer than
 * `perMinute` of them are less than a window old. Exact, not an average: no 60 seconds ever hold more than `perMinute`.
 * Callers are served one at a time, in order.
 */
export function createRateLimiter(opts: { perMinute: number; windowMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> }): RateLimiter {
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const starts: number[] = [];
  let chain: Promise<void> = Promise.resolve();

  return {
    acquire() {
      const turn = chain.then(async () => {
        for (;;) {
          const t = now();
          while (starts.length > 0 && starts[0]! <= t - windowMs) starts.shift();
          if (starts.length < opts.perMinute) {
            starts.push(t);
            return;
          }
          await sleep(starts[0]! + windowMs - t);
        }
      });
      chain = turn.catch(() => {});
      return turn;
    },
  };
}
