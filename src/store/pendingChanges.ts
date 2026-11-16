/**
 * Optimistic changes the cache hasn't caught up with yet. A store registers each change for the keys it touches under
 * the id of the action that made it, lays every live change over the data it loads (so a reload answered before the
 * command reached the cache can't bring the old state back), and settles the action's changes once its command has
 * been confirmed or refused. A key's changes apply in the order they were made.
 */
export class PendingChanges<K, V> {
  private byKey = new Map<K, Array<{ op: number; change: V }>>();

  /** No change is waiting, so loaded data can be used as it is. */
  get isEmpty(): boolean {
    return this.byKey.size === 0;
  }

  /** Waits `change` for every one of `keys` under `op`, after the changes already waiting for them. */
  add(keys: Iterable<K>, op: number, change: V): void {
    for (const key of keys) this.byKey.set(key, [...(this.byKey.get(key) ?? []), { op, change }]);
  }

  /** `value` (freshly loaded for `key`) with each change waiting for it laid over in turn by `step`. */
  apply<T>(key: K, value: T, step: (value: T, change: V) => T): T {
    return (this.byKey.get(key) ?? []).reduce((out, { change }) => step(out, change), value);
  }

  /**
   * The command for `op` has settled: its changes stop being applied, for `keys` only when given (an action whose
   * accounts settle one at a time). Returns the released changes with their keys, in the order they were waiting.
   */
  settle(op: number, keys?: Iterable<K>): Array<[K, V]> {
    const only = keys ? new Set(keys) : null;
    const released: Array<[K, V]> = [];
    for (const [key, changes] of this.byKey) {
      if (only && !only.has(key)) continue;
      for (const c of changes) if (c.op === op) released.push([key, c.change]);
      const rest = changes.filter((c) => c.op !== op);
      if (rest.length > 0) this.byKey.set(key, rest);
      else this.byKey.delete(key);
    }
    return released;
  }

  /** Forget every waiting change. */
  clear(): void {
    this.byKey.clear();
  }
}
