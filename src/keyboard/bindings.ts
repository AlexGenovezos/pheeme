import { platform } from "../lib/platform";
import {
  type Command,
  type CommandRegistry,
  MODIFIER_KEYS,
  parseShortcut,
  registry as defaultRegistry,
  shiftSignificant,
  stepId,
} from "./registry";

/**
 * The user's shortcut changes, kept in localStorage as `{ [commandId]: shortcut | null }` and
 * applied to the registry. Only differences from the defaults are stored, so a default that
 * changes in a later release reaches everyone who hasn't rebound that command.
 */
export const KEYBINDINGS_KEY = "pheeme.keybindings";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function readBindings(
  storage: StorageLike | undefined = defaultStorage(),
): Record<string, string | null> {
  try {
    const raw: unknown = JSON.parse(storage?.getItem(KEYBINDINGS_KEY) ?? "null");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw).filter(
        (entry): entry is [string, string | null] =>
          entry[1] === null || (typeof entry[1] === "string" && isValidShortcut(entry[1])),
      ),
    );
  } catch {
    return {};
  }
}

function isValidShortcut(shortcut: string): boolean {
  try {
    return parseShortcut(shortcut).length > 0;
  } catch {
    return false;
  }
}

function write(overrides: Record<string, string | null>, storage = defaultStorage()) {
  try {
    storage?.setItem(KEYBINDINGS_KEY, JSON.stringify(overrides));
  } catch {
    // Storage unavailable: the binding lasts until the app closes.
  }
}

/** Apply the stored bindings to the registry. Call once at startup. */
export function loadBindings(reg: CommandRegistry = defaultRegistry, storage = defaultStorage()) {
  reg.setOverrides(readBindings(storage));
}

/** Bind `shortcut` to a command (`null` removes its shortcut). Binding the default clears the override. */
export function setBinding(
  id: string,
  shortcut: string | null,
  reg: CommandRegistry = defaultRegistry,
) {
  const next = { ...reg.overrides() };
  if (sameShortcut(shortcut, reg.defaultShortcut(id) ?? null)) delete next[id];
  else next[id] = shortcut;
  reg.setOverrides(next);
  write(next);
}

/** Bind several commands at once, e.g. take a shortcut from one command and give it to another. */
export function setBindings(
  changes: Record<string, string | null>,
  reg: CommandRegistry = defaultRegistry,
) {
  const next = { ...reg.overrides() };
  for (const [id, shortcut] of Object.entries(changes)) {
    if (sameShortcut(shortcut, reg.defaultShortcut(id) ?? null)) delete next[id];
    else next[id] = shortcut;
  }
  reg.setOverrides(next);
  write(next);
}

export function resetBinding(id: string, reg: CommandRegistry = defaultRegistry) {
  const next = { ...reg.overrides() };
  delete next[id];
  reg.setOverrides(next);
  write(next);
}

export function resetAllBindings(reg: CommandRegistry = defaultRegistry) {
  reg.setOverrides({});
  write({});
}

const stepIds = (shortcut: string) => parseShortcut(shortcut).map(stepId);

export function sameShortcut(a: string | null, b: string | null): boolean {
  if (!a || !b) return !a && !b;
  return stepIds(a).join(" ") === stepIds(b).join(" ");
}

/**
 * Commands that `shortcut` would collide with: the same keys, or one a chord prefix of the other
 * (binding `g` would make `g i` unreachable, and the other way round).
 */
export function findConflicts(shortcut: string, commands: Command[], exceptId: string): Command[] {
  const mine = stepIds(shortcut);
  return commands.filter((c) => {
    if (c.id === exceptId || !c.shortcut) return false;
    const theirs = stepIds(c.shortcut);
    const n = Math.min(mine.length, theirs.length);
    return mine.slice(0, n).join(" ") === theirs.slice(0, n).join(" ");
  });
}

/**
 * One chord step from a keydown, in registry syntax (`"mod+shift+l"`, `"#"`, `"space"`), or null
 * for a lone modifier. Cmd on macOS and Ctrl elsewhere record as `mod`, so a binding made on one
 * platform means the same thing on the other.
 */
export function stepFromEvent(
  e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  isMac = platform === "macos",
): string | null {
  let key = e.key.toLowerCase();
  if (MODIFIER_KEYS.has(key) || key === "dead" || key === "unidentified") return null;
  // Option+letter on macOS types a symbol; record the physical letter, as matching does.
  if (e.altKey && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  if (key === " ") key = "space";
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const parts = [
    mod && "mod",
    isMac && e.ctrlKey && "ctrl",
    e.altKey && "alt",
    e.shiftKey && shiftSignificant(key === "space" ? " " : key) && "shift",
    !isMac && e.metaKey && "meta",
  ].filter(Boolean);
  return [...parts, key].join("+");
}
