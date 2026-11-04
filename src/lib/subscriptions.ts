import { stopQuietly } from "./tauri";

type Unsubscribe = () => void;
type Subscription = (signal: AbortSignal) => Promise<Unsubscribe>;

/** Own asynchronous listeners for one lifetime, including those acquired after it ends. */
export function createSubscriptionScope(parentSignal?: AbortSignal) {
  let disposed = false;
  const stops = new Set<Unsubscribe>();
  const controller = new AbortController();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    parentSignal?.removeEventListener("abort", dispose);
    controller.abort();
    for (const stop of stops) stopQuietly(stop);
    stops.clear();
  };
  parentSignal?.addEventListener("abort", dispose, { once: true });
  if (parentSignal?.aborted) dispose();

  return {
    async add(subscribe: Subscription): Promise<void> {
      // Nested groups use the signal to release partial setup before the whole group is ready.
      const stop = await subscribe(controller.signal);
      if (disposed) stopQuietly(stop);
      else stops.add(stop);
    },
    dispose,
  };
}

/** Acquire a group together; a failed registration releases successful and late arrivals. */
export async function subscribeAll(
  subscriptions: Subscription[],
  signal?: AbortSignal,
): Promise<Unsubscribe> {
  const scope = createSubscriptionScope(signal);
  try {
    await Promise.all(subscriptions.map(scope.add));
    return scope.dispose;
  } catch (error) {
    scope.dispose();
    throw error;
  }
}
