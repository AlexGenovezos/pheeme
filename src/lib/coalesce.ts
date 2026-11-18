/**
 * At most one run of `run` at a time. A call while one runs queues a single follow-up with the latest
 * arguments; every call made meanwhile shares it and resolves when it finishes. So a burst of reloads costs
 * the one running plus one more, never one each.
 *
 * In a mailbox of 800,000 messages a count or list query takes a second or more, and every read, sync and
 * outbox change asked for another: the queries queued behind each other until every other read in the app
 * waited tens of seconds for a database connection (diagnostics report, v0.28).
 */
export interface Coalesced<A extends unknown[]> {
  (...args: A): Promise<void>;
  /** Forget a run in progress and the follow-up queued behind it (tests start each case clean). */
  reset(): void;
}

export function coalesce<A extends unknown[]>(run: (...args: A) => Promise<void>): Coalesced<A> {
  let running = false;
  // Bumped by `reset`, so a run started before it doesn't start the follow-up after it.
  let generation = 0;
  let next: { args: A; promise: Promise<void>; settle: (outcome: Promise<void>) => void } | null =
    null;

  const start = (args: A): Promise<void> => {
    running = true;
    const mine = generation;
    // Settled in `finally`, so whoever awaits this run finds it over (and the follow-up started).
    const finish = () => {
      if (mine !== generation) return;
      running = false;
      const queued = next;
      next = null;
      if (queued) queued.settle(start(queued.args));
    };
    return (async () => {
      try {
        await run(...args);
      } finally {
        finish();
      }
    })();
  };

  const call = (...args: A) => {
    if (!running) return start(args);
    if (next) {
      next.args = args;
      return next.promise;
    }
    let settle!: (outcome: Promise<void>) => void;
    const promise = new Promise<void>((resolve) => (settle = resolve));
    next = { args, promise, settle };
    return promise;
  };
  return Object.assign(call, {
    reset() {
      generation++;
      running = false;
      next?.settle(Promise.resolve());
      next = null;
    },
  });
}
