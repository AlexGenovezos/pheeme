import { logWindowProblem, type WindowProblem } from "./tauri";

/**
 * Sends problems in the window to the diagnostics log (`log_window_problem`): uncaught errors and
 * promise rejections, and the main thread falling behind while the user has the window focused.
 * The backend's stall watch can't see the window's own thread, and an error nothing caught would
 * otherwise leave no trace in a report. Repeats are folded and the rate is capped, so a loop
 * throwing every frame can't flood the log. The freeze check ticks only while the window is focused.
 */

/** How often the main thread is checked. */
export const STALL_TICK_MS = 1000;
/** Lateness worth a report: the window froze long enough to notice. */
export const STALL_MS = 1000;
/** The same problem again within this window adds to its repeats instead of a new line. */
export const REPEAT_WINDOW_MS = 60_000;
/** At most this many reports in any minute. */
export const MAX_PER_MINUTE = 10;
/** Longest message kept. */
const MAX_MESSAGE = 600;
/** Stack frames kept after the message. */
const STACK_FRAMES = 3;

/** Browser noise that says nothing about Pheeme. */
const IGNORED = [/ResizeObserver loop/];

export interface WindowProblemDeps {
  now(): number;
  every(ms: number, fn: () => void): () => void;
  visible(): boolean;
  focused(): boolean;
  report(problem: WindowProblem): void;
}

export interface ProblemLog {
  error(kind: "error" | "rejection", error: unknown): void;
  /** One tick of the stall check. */
  tick(): void;
  /** Run the stall check (while the window is focused and visible) or stop it. */
  watch(on: boolean): void;
}

export function createProblemLog(deps: WindowProblemDeps): ProblemLog {
  let lastTick = deps.now();
  /** When each message last went out, and repeats held back since. */
  const recent = new Map<string, { at: number; held: number }>();
  const sent: number[] = [];

  /** Send `problem`; `key` folds repeats of the same one (stalls are never folded). */
  const send = (
    problem: Omit<WindowProblem, "repeats" | "visible" | "focused">,
    key: string | null,
  ) => {
    const now = deps.now();
    for (const [k, v] of recent)
      if (v.held === 0 && now - v.at >= REPEAT_WINDOW_MS) recent.delete(k);
    const seen = key == null ? undefined : recent.get(key);
    if (seen && now - seen.at < REPEAT_WINDOW_MS) {
      seen.held += 1;
      return;
    }
    while (sent.length && now - sent[0] >= 60_000) sent.shift();
    if (sent.length >= MAX_PER_MINUTE) {
      if (seen) seen.held += 1;
      return;
    }
    sent.push(now);
    if (key != null) recent.set(key, { at: now, held: 0 });
    deps.report({
      ...problem,
      repeats: seen?.held ?? 0,
      visible: deps.visible(),
      focused: deps.focused(),
    });
  };

  let cancel: (() => void) | null = null;

  const log: ProblemLog = {
    error(kind, error) {
      const message = describe(error);
      if (IGNORED.some((re) => re.test(message))) return;
      // Folded by the message alone: the same error thrown from two places is one problem.
      send({ kind, message, lagMs: null }, `${kind}\u0000${message.split(" | ")[0]}`);
    },
    tick() {
      const now = deps.now();
      const lag = now - lastTick - STALL_TICK_MS;
      lastTick = now;
      // Hidden or in the background, the system slows the window's timers on purpose.
      if (lag < STALL_MS || !deps.visible() || !deps.focused()) return;
      send({ kind: "stall", message: null, lagMs: Math.round(lag) }, null);
    },
    watch(on) {
      if (on === (cancel != null)) return;
      cancel?.();
      cancel = null;
      if (!on) return;
      lastTick = deps.now();
      cancel = deps.every(STALL_TICK_MS, () => log.tick());
    },
  };
  log.watch(deps.visible() && deps.focused());
  return log;
}

/** `Name: message` and the first stack frames, with the app's own origin left out. */
export function describe(error: unknown): string {
  let text: string;
  if (error instanceof Error) {
    const frames = (error.stack ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith(`${error.name}:`) && line !== error.message)
      .slice(0, STACK_FRAMES)
      .map((line) => line.replace(/(?:tauri|https?):\/\/[^/]+\//g, ""));
    text = [`${error.name}: ${error.message}`, ...frames].join(" | ");
  } else if (typeof error === "string") {
    text = error;
  } else {
    try {
      text = JSON.stringify(error) ?? String(error);
    } catch {
      text = String(error);
    }
  }
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text;
}

/** Start reporting the window's problems; once per window. */
export function watchWindowProblems() {
  const log = createProblemLog({
    now: () => performance.now(),
    every: (ms, fn) => {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    },
    visible: () => document.visibilityState === "visible",
    focused: () => document.hasFocus(),
    report: (problem) => void logWindowProblem(problem).catch(() => undefined),
  });
  window.addEventListener("error", (e) => {
    if (e instanceof ErrorEvent) log.error("error", e.error ?? e.message);
  });
  window.addEventListener("unhandledrejection", (e) => log.error("rejection", e.reason));
  // Ticks only while the user could notice a freeze, so a window in the background costs nothing.
  const rewatch = () => log.watch(document.visibilityState === "visible" && document.hasFocus());
  window.addEventListener("focus", rewatch);
  window.addEventListener("blur", () => log.watch(false));
  document.addEventListener("visibilitychange", rewatch);
}
