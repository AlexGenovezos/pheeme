import { logThreadShown, type ShownTiming } from "../lib/tauri";
import { isComplete, useThreadStore } from "../store/threadStore";
import { useUiStore } from "../store/uiStore";

/**
 * Times what the user waits for after picking a conversation: its data, the first paint, and every image in its
 * email bodies. The backend times only `get_thread`, which a conversation already in memory never calls, and the
 * drawing happens here, so a "slow to open" report needs this side too. Each pick is reported once, to the
 * diagnostics log (`log_thread_shown`).
 */

/** The parts of an `<img>` this reads, so tests can drive images by hand. */
export interface Img {
  complete: boolean;
  naturalWidth: number;
  loading: string;
  addEventListener(type: "load" | "error", fn: () => void): void;
  removeEventListener(type: "load" | "error", fn: () => void): void;
}

export interface OpenTimerDeps {
  now(): number;
  /** Run `fn` before the next paint. */
  frame(fn: () => void): void;
  /** Run `fn` after `ms`; returns a cancel. */
  after(ms: number, fn: () => void): () => void;
  /** The conversation's data is already in memory. */
  isCached(key: string): boolean;
  /** Images in the conversation's email frames. */
  imagesIn(root: Element): Img[];
  report(timing: ShownTiming): void;
}

/** Past this the open is reported as `timed_out`, whatever is still loading. */
export const SHOWN_TIMEOUT_MS = 30_000;

export interface OpenTimer {
  /** The user picked a conversation (null: closed it). Ends the previous pick's timing. */
  picked(key: string | null): void;
  /** The conversation's DOM is mounted with all its data (or the reason a body is missing), under `root`. */
  shown(key: string, root: Element): void;
}

interface Pending {
  key: string;
  start: number;
  fromMemory: boolean;
  dataMs: number | null;
  paintMs: number | null;
  images: Img[];
  cancel: Array<() => void>;
}

export function createOpenTimer(deps: OpenTimerDeps): OpenTimer {
  let pending: Pending | null = null;

  const elapsed = (p: Pending) => Math.round(deps.now() - p.start);

  const finish = (p: Pending, outcome: ShownTiming["outcome"]) => {
    if (pending !== p) return;
    pending = null;
    for (const cancel of p.cancel) cancel();
    const settled = p.images.filter((img) => img.complete);
    const done = outcome === "shown";
    deps.report({
      outcome,
      fromMemory: p.fromMemory,
      dataMs: p.dataMs,
      paintMs: p.paintMs,
      imagesMs: done && p.images.length > 0 ? elapsed(p) : null,
      images: p.images.length,
      imagesFailed: settled.filter((img) => img.naturalWidth === 0).length,
      imagesPending: p.images.length - settled.length,
      totalMs: elapsed(p),
    });
  };

  const waitForImages = (p: Pending) => {
    const check = () => {
      if (p.images.every((img) => img.complete)) finish(p, "shown");
    };
    for (const img of p.images) {
      if (img.complete) continue;
      img.addEventListener("load", check);
      img.addEventListener("error", check);
      p.cancel.push(() => {
        img.removeEventListener("load", check);
        img.removeEventListener("error", check);
      });
    }
    check();
  };

  return {
    picked(key) {
      if (pending && pending.key === key) return;
      if (pending) finish(pending, "left");
      if (key === null) return;
      const p: Pending = {
        key,
        start: deps.now(),
        fromMemory: deps.isCached(key),
        dataMs: null,
        paintMs: null,
        images: [],
        cancel: [],
      };
      pending = p;
      p.cancel.push(deps.after(SHOWN_TIMEOUT_MS, () => finish(p, "timed_out")));
    },
    shown(key, root) {
      const p = pending;
      if (!p || p.key !== key || p.dataMs !== null) return;
      p.dataMs = elapsed(p);
      // A frame callback runs before that frame paints; the next one runs after it has.
      deps.frame(() =>
        deps.frame(() => {
          if (pending !== p) return;
          p.paintMs = elapsed(p);
          p.images = deps.imagesIn(root).filter((img) => img.loading !== "lazy");
          waitForImages(p);
        }),
      );
    },
  };
}

/** Images inside the email frames under `root` (each frame is a same-origin document the app wrote). */
function frameImages(root: Element): Img[] {
  return [...root.querySelectorAll("iframe")].flatMap((frame) => [
    ...(frame.contentDocument?.images ?? []),
  ]);
}

let installed: OpenTimer | null = null;

/** The app's timer, following `uiStore.openThread`. Idempotent. */
export function openTimer(): OpenTimer {
  if (installed) return installed;
  const timer = createOpenTimer({
    now: () => performance.now(),
    frame: (fn) => void requestAnimationFrame(fn),
    after: (ms, fn) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
    // Mirrors `threadStore.load`: a cached conversation missing a body still calls `get_thread`.
    isCached: (key) => {
      const cached = useThreadStore.getState().details.get(key);
      return cached !== undefined && isComplete(cached);
    },
    imagesIn: frameImages,
    report: (timing) => void logThreadShown(timing).catch(() => {}),
  });
  useUiStore.subscribe((s, prev) => {
    if (s.openThread !== prev.openThread) timer.picked(s.openThread);
  });
  timer.picked(useUiStore.getState().openThread);
  installed = timer;
  return timer;
}
