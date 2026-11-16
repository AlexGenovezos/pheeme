// Browser storage that never throws: with storage turned off, full, or blocked, a read finds nothing and a
// write is dropped, so a preference just doesn't survive a relaunch and nothing else breaks.

/** `localStorage`, or `undefined` where even touching it throws (storage disabled). */
export function defaultStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** The text stored under `key`, `null` when there is none or storage can't be read. */
export function readItem(
  key: string,
  storage: Pick<Storage, "getItem"> | undefined = defaultStorage(),
): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** The JSON stored under `key`, `undefined` when there is none or it doesn't parse: callers check its shape. */
export function readJson(
  key: string,
  storage: Pick<Storage, "getItem"> | undefined = defaultStorage(),
): unknown {
  try {
    return JSON.parse(readItem(key, storage) ?? "null") ?? undefined;
  } catch {
    return undefined;
  }
}

/** Store `value` under `key`; quota and privacy-mode errors are swallowed. */
export function writeItem(
  key: string,
  value: string,
  storage: Pick<Storage, "setItem"> | undefined = defaultStorage(),
) {
  try {
    storage?.setItem(key, value);
  } catch {
    // The value just won't survive a relaunch.
  }
}

export function writeJson(
  key: string,
  value: unknown,
  storage: Pick<Storage, "setItem"> | undefined = defaultStorage(),
) {
  writeItem(key, JSON.stringify(value), storage);
}
