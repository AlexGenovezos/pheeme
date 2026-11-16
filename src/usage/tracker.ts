// Counts for the anonymous usage report: how often each screen opened and how long it was on
// screen, and how often each command ran by shortcut, palette or button. Kept in memory until
// `take` hands them to Rust (`record_usage`), which adds them to the day's report. Nothing
// records the order things happened in.
//
// Time on screen counts only while someone is there: the window focused and visible, and some
// input in the last `IDLE_MS`. It is settled when something changes (a screen opens or closes,
// the window loses focus, input after a pause, `take`), never by a timer.

import type { RunSource } from "../keyboard/registry";

/** No input for this long and the time stops counting, until the next input. */
export const IDLE_MS = 2 * 60 * 1000;

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

export interface ScreenCount {
  name: string;
  opens: number;
  ms: number;
}

export interface CommandCount {
  id: string;
  source: RunSource;
  count: number;
}

export interface UsageCounts {
  screens: ScreenCount[];
  commands: CommandCount[];
}

/** The name a command is counted under: a mod's commands all count as `mod`, never their own ids. */
export function commandName(id: string): string | null {
  if (id.startsWith("mod:")) return "mod";
  return NAME_RE.test(id) ? id : null;
}

export function createUsageTracker(now: () => number = Date.now) {
  /** Screens on screen now. */
  let open = new Set<string>();
  const opens = new Map<string, number>();
  const ms = new Map<string, number>();
  const commands = new Map<string, CommandCount>();
  let attentive = true;
  let lastInput = now();
  /** Since when the open screens' time hasn't been added. */
  let since = now();

  /** Add the time since `since` to every open screen, up to `IDLE_MS` after the last input. */
  function settle() {
    const t = now();
    if (attentive) {
      const until = Math.min(t, lastInput + IDLE_MS);
      const spent = until - since;
      if (spent > 0) for (const name of open) ms.set(name, (ms.get(name) ?? 0) + spent);
    }
    since = t;
  }

  return {
    /** The screens showing now; those not showing before count as opened. */
    setScreens(names: Iterable<string>) {
      const next = new Set([...names].filter((n) => NAME_RE.test(n)));
      settle();
      for (const name of next) if (!open.has(name)) opens.set(name, (opens.get(name) ?? 0) + 1);
      open = next;
    },

    /** The window gained or lost focus or visibility. */
    setAttentive(value: boolean) {
      if (value === attentive) return;
      settle();
      attentive = value;
      if (value) lastInput = now();
    },

    /** Any key, click, scroll or pointer move. */
    input() {
      const t = now();
      if (t - lastInput > IDLE_MS) {
        settle();
        since = t;
      }
      lastInput = t;
    },

    command(id: string, source: RunSource) {
      const name = commandName(id);
      if (!name) return;
      const key = `${source} ${name}`;
      const entry = commands.get(key);
      if (entry) entry.count++;
      else commands.set(key, { id: name, source, count: 1 });
    },

    /** Everything counted since the last take, then start again from zero. */
    take(): UsageCounts {
      settle();
      const names = new Set([...opens.keys(), ...ms.keys()]);
      const screens = [...names]
        .map((name) => ({ name, opens: opens.get(name) ?? 0, ms: Math.round(ms.get(name) ?? 0) }))
        .filter((s) => s.opens > 0 || s.ms > 0);
      const counts = { screens, commands: [...commands.values()] };
      opens.clear();
      ms.clear();
      commands.clear();
      return counts;
    },
  };
}

const discards = new Set<() => void>();

/** Drop the counts not yet flushed. The usage stats switch calls it whenever it changes, so
 * nothing counted while the stats were off is sent after they're turned back on. */
export function discardUsageCounts() {
  discards.forEach((d) => d());
}

/** Run `discard` on [`discardUsageCounts`]; returns a function that stops. */
export function onDiscard(discard: () => void): () => void {
  discards.add(discard);
  return () => discards.delete(discard);
}
