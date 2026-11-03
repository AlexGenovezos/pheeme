import { platform } from "../lib/platform";

/**
 * The single list of things a user can do from the keyboard. The global
 * keydown handler and the command palette both read from here, so a command
 * registered once gets a shortcut, a palette entry and a shortcut label.
 *
 * Shortcut syntax: steps separated by spaces, keys within a step joined by
 * `+`. `mod` is Cmd on macOS and Ctrl elsewhere. Examples: `"e"`, `"#"`,
 * `"g i"`, `"mod+k"`, `"mod+shift+l"`.
 */
export interface Command {
  id: string;
  title: string;
  /** Palette section, e.g. "Navigation". */
  group?: string;
  shortcut?: string;
  /** Extra words the palette matches on. */
  keywords?: string[];
  /** Fire even while typing in a text field. Use only for modifier shortcuts. */
  global?: boolean;
  /** Keep out of the palette (still reachable by shortcut). */
  hidden?: boolean;
  run(): void;
}

interface Step {
  key: string;
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

interface Entry {
  command: Command;
  steps: Step[];
}

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  return: "enter",
  space: " ",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  del: "delete",
};

export const MODIFIER_KEYS = new Set([
  "shift",
  "control",
  "alt",
  "meta",
  "os",
  "altgraph",
  "capslock",
]);

export function parseShortcut(shortcut: string): Step[] {
  return shortcut
    .trim()
    .split(/\s+/)
    .map((token) => {
      // "+" itself is a key ("shift++" or a bare "+"), so split on "+" only between parts.
      const parts = token === "+" ? ["+"] : token.split(/\+(?!$)/);
      const step: Step = {
        key: "",
        mod: false,
        ctrl: false,
        alt: false,
        shift: false,
        meta: false,
      };
      for (const raw of parts) {
        const part = raw.toLowerCase();
        if (part === "mod") step.mod = true;
        else if (part === "ctrl" || part === "control") step.ctrl = true;
        else if (part === "alt" || part === "option") step.alt = true;
        else if (part === "shift") step.shift = true;
        else if (part === "meta" || part === "cmd") step.meta = true;
        else step.key = KEY_ALIASES[part] ?? part;
      }
      if (!step.key) throw new Error(`Shortcut "${shortcut}" has a step with no key`);
      return step;
    });
}

export const stepId = (s: Step) =>
  `${s.mod ? "mod+" : ""}${s.ctrl ? "ctrl+" : ""}${s.alt ? "alt+" : ""}${s.shift ? "shift+" : ""}${s.meta ? "meta+" : ""}${s.key}`;

/** Keys whose shifted form is a different character ("?", "#") already encode Shift in `event.key`. */
export const shiftSignificant = (key: string) => key.length > 1 || /^[a-z0-9]$/.test(key);

function stepMatches(step: Step, e: KeyboardEvent, isMac: boolean): boolean {
  let key = e.key.toLowerCase();
  // Option+letter on macOS produces a symbol in e.key; fall back to the physical key.
  if (step.alt && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  if (key !== step.key) return false;
  const wantMeta = step.meta || (step.mod && isMac);
  const wantCtrl = step.ctrl || (step.mod && !isMac);
  if (e.metaKey !== wantMeta || e.ctrlKey !== wantCtrl || e.altKey !== step.alt) return false;
  return !shiftSignificant(step.key) || e.shiftKey === step.shift;
}

/**
 * Text fields own their keystrokes; only `global` commands fire inside them. So does anything inside a
 * `data-owns-keys` region (a compose panel), where `e` or `a` on a button mustn't archive or reply.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("[data-owns-keys]")) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  if (target.closest('[contenteditable]:not([contenteditable="false"])')) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(
      target.type,
    );
  }
  return false;
}

const hasModifier = (s: Step) => s.mod || s.ctrl || s.alt || s.meta;

export interface RegistryOptions {
  isMac?: boolean;
  chordTimeoutMs?: number;
}

export type CommandRegistry = ReturnType<typeof createRegistry>;

export function createRegistry({
  isMac = platform === "macos",
  chordTimeoutMs = 1500,
}: RegistryOptions = {}) {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let snapshot: Command[] = [];
  /** User rebindings by command id; `null` means the user removed the shortcut. */
  let overrides: Readonly<Record<string, string | null>> = {};
  let pending: string[] = [];
  let suspended = 0;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;

  const emit = () => listeners.forEach((l) => l());

  const hasOverride = (id: string) => Object.prototype.hasOwnProperty.call(overrides, id);

  /** The shortcut a command answers to: the user's binding if they set one, else its default. */
  function effective(command: Command): string | undefined {
    return hasOverride(command.id) ? (overrides[command.id] ?? undefined) : command.shortcut;
  }

  function stepsFor(command: Command): Step[] {
    const shortcut = effective(command);
    if (!shortcut) return [];
    try {
      return parseShortcut(shortcut);
    } catch {
      // A stored binding that no longer parses: fall back to the default.
      return command.shortcut ? parseShortcut(command.shortcut) : [];
    }
  }

  function view(command: Command): Command {
    const shortcut = effective(command);
    return shortcut === command.shortcut ? command : { ...command, shortcut };
  }

  function rebuild() {
    snapshot = [...entries.values()].map((e) => view(e.command));
    emit();
  }

  function setPending(next: string[]) {
    clearTimeout(pendingTimer);
    pending = next;
    if (next.length) pendingTimer = setTimeout(() => setPending([]), chordTimeoutMs);
    emit();
  }

  function startsWith(entry: Entry, prefix: string[]) {
    return prefix.every((id, i) => entry.steps[i] && stepId(entry.steps[i]) === id);
  }

  return {
    /** Add (or replace) a command. Returns a function that removes it. */
    register(command: Command): () => void {
      if (command.shortcut) parseShortcut(command.shortcut); // a bad default is a bug: throw now
      const entry: Entry = { command, steps: stepsFor(command) };
      const shortcut = effective(command);
      if (import.meta.env.DEV && shortcut) {
        const clash = [...entries.values()].find(
          (e) => e.command.id !== command.id && effective(e.command) === shortcut,
        );
        if (clash)
          console.warn(
            `Shortcut "${shortcut}" is bound to both ${clash.command.id} and ${command.id}`,
          );
      }
      entries.set(command.id, entry);
      rebuild();
      return () => {
        if (entries.get(command.id) !== entry) return;
        entries.delete(command.id);
        rebuild();
      };
    },

    list: (): Command[] => snapshot,

    /** The command as it behaves now: `shortcut` is the effective one. */
    get: (id: string): Command | undefined => {
      const command = entries.get(id)?.command;
      return command && view(command);
    },

    /** The shortcut the command was registered with, before any user binding. */
    defaultShortcut: (id: string): string | undefined => entries.get(id)?.command.shortcut,

    /**
     * The shortcut to show for a command: the user's binding, else the registered default, else
     * `fallback` (for labels drawn while the command isn't registered).
     */
    shortcutFor(id: string, fallback?: string): string | undefined {
      if (hasOverride(id)) return overrides[id] ?? undefined;
      return entries.get(id)?.command.shortcut ?? fallback;
    },

    overrides: () => overrides,

    /** Replace the user's bindings; every command re-reads its shortcut. */
    setOverrides(next: Record<string, string | null>) {
      overrides = { ...next };
      for (const entry of entries.values()) entry.steps = stepsFor(entry.command);
      setPending([]);
      rebuild();
    },

    /** Stop handling keys (while a dialog owns the keyboard). Returns a function that resumes. */
    suspend(): () => void {
      suspended++;
      setPending([]);
      let resumed = false;
      return () => {
        if (resumed) return;
        resumed = true;
        suspended--;
      };
    },

    run(id: string): boolean {
      const command = entries.get(id)?.command;
      command?.run();
      return Boolean(command);
    },

    /** The chord prefix typed so far, e.g. `"g"`, or null. */
    pendingChord: (): string | null => (pending.length ? pending.join(" ") : null),

    /** Commands that would complete the pending chord, with the key each still needs. */
    completions(): Array<{ command: Command; next: string }> {
      if (!pending.length) return [];
      return [...entries.values()]
        .filter((en) => en.steps.length === pending.length + 1 && startsWith(en, pending))
        .map((en) => ({ command: en.command, next: stepId(en.steps[pending.length]) }));
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Returns true when the event triggered (or continued) a shortcut. */
    handleKeyDown(e: KeyboardEvent): boolean {
      if (
        suspended ||
        e.defaultPrevented ||
        e.isComposing ||
        MODIFIER_KEYS.has(e.key.toLowerCase())
      )
        return false;
      const editable = isEditableTarget(e.target);
      const live = [...entries.values()].filter(
        // A `global` command rebound to a plain key must not eat that key while the user types.
        (en) => en.steps.length && (!editable || (en.command.global && hasModifier(en.steps[0]))),
      );

      if (pending.length) {
        const prefix = pending;
        const next = live.filter(
          (en) =>
            en.steps.length > prefix.length &&
            startsWith(en, prefix) &&
            stepMatches(en.steps[prefix.length], e, isMac),
        );
        const done = next.find((en) => en.steps.length === prefix.length + 1);
        if (done) {
          setPending([]);
          e.preventDefault();
          done.command.run();
          return true;
        }
        if (next.length) {
          setPending([...prefix, stepId(next[0].steps[prefix.length])]);
          e.preventDefault();
          return true;
        }
        setPending([]); // not part of the chord: drop it and treat this key on its own
      }

      const chord = live.find((en) => en.steps.length > 1 && stepMatches(en.steps[0], e, isMac));
      if (chord && !e.repeat) {
        setPending([stepId(chord.steps[0])]);
        e.preventDefault();
        return true;
      }

      const single = live.find((en) => en.steps.length === 1 && stepMatches(en.steps[0], e, isMac));
      if (!single) return false;
      e.preventDefault();
      single.command.run();
      return true;
    },

    /** Test helper: drop all commands and chord state. */
    clear() {
      entries.clear();
      overrides = {};
      suspended = 0;
      setPending([]);
      rebuild();
    },
  };
}

/** The app-wide registry. */
export const registry = createRegistry();
