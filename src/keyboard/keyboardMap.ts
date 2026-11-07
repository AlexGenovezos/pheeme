import type { Platform } from "../lib/platform";
import { describeShortcut, formatShortcut } from "./format";
import { type Command, parseShortcut } from "./registry";

/** A modifier as the user presses it: `mod` is already resolved to Cmd or Ctrl. */
export type Modifier = "ctrl" | "alt" | "shift" | "meta";

/** Same order as `formatShortcut` draws them. */
const MODIFIERS: Modifier[] = ["ctrl", "alt", "shift", "meta"];

/** One key cap on the drawn keyboard. `key` uses the registry's key names ("escape", "3", ","). */
export interface BoardKey {
  key: string;
  /** Relative width; a letter key is 1. */
  width: number;
  modifier?: Modifier;
  /** Overrides the cap label `formatShortcut` would give the key. */
  label?: string;
}

const k = (key: string, width = 1, label?: string): BoardKey => ({ key, width, label });
const mod = (modifier: Modifier, width: number, label: string): BoardKey => ({
  key: modifier,
  width,
  modifier,
  label,
});
const keys = (chars: string) => [...chars].map((c) => k(c));

/** A US layout: Mac-style on macOS, PC-style elsewhere. */
export function boardRows(platform: Platform): BoardKey[][] {
  const mac = platform === "macos";
  const shift = (width: number) => mod("shift", width, mac ? "⇧" : "Shift");
  const ctrl = mod("ctrl", mac ? 1 : 1.4, mac ? "⌃" : "Ctrl");
  const alt = mod("alt", mac ? 1.1 : 1.2, mac ? "⌥" : "Alt");
  const meta = mod("meta", mac ? 1.4 : 1.2, mac ? "⌘" : "Win");
  const arrows = [k("arrowleft"), k("arrowup"), k("arrowdown"), k("arrowright")];
  return [
    [k("escape", 1.3), ...keys("`1234567890-="), k("backspace", 1.5, "⌫")],
    [k("tab", 1.5), ...keys("qwertyuiop[]\\")],
    [k("capslock", 1.8, mac ? "⇪" : "Caps"), ...keys("asdfghjkl;'"), k("enter", 2)],
    [shift(2.3), ...keys("zxcvbnm,./"), shift(2.6)],
    mac
      ? [k("fn", 1, "fn"), ctrl, alt, meta, k(" ", 5.6, ""), meta, alt, ...arrows]
      : [ctrl, meta, alt, k(" ", 6, ""), alt, ctrl, ...arrows],
  ];
}

export function capLabel(key: BoardKey, platform: Platform): string {
  return key.label ?? formatShortcut(key.key, platform)[0].slice(-1)[0];
}

/** Characters typed with Shift on a US keyboard, and the key that types them. */
const SHIFTED: Record<string, string> = {
  "~": "`",
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  _: "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
};

/** One layer of the map: the shortcuts that share the same modifiers and sequence prefix. */
export interface MapLayer {
  id: string;
  /** "No modifier", "⌘", "Ctrl+Shift", "G then…". */
  label: string;
  mods: Modifier[];
  /** The step typed first (`"g"`), for sequence layers. */
  prefix: string | null;
  /** The board key that starts the sequence, and the layer it sits on. */
  prefixKey: string | null;
  parent: string | null;
  /** Commands by the board key that finishes them. */
  bindings: Map<string, Command[]>;
  /** Board keys that start a sequence, with the layer that sequence opens. */
  prefixes: Map<string, string>;
}

export const PLAIN_LAYER = "";

const modsId = (mods: Iterable<Modifier>) =>
  MODIFIERS.filter((m) => [...mods].includes(m)).join("+");

export function layerIdFor(mods: Iterable<Modifier>, prefix: string | null = null): string {
  return prefix === null ? modsId(mods) : `${prefix} then ${modsId(mods)}`;
}

function modsLabel(mods: Modifier[], platform: Platform): string {
  if (!mods.length) return "";
  // formatShortcut draws the caps; "x" is a stand-in key, dropped again.
  const caps = formatShortcut([...mods, "x"].join("+"), platform)[0].slice(0, -1);
  return caps.join(platform === "macos" ? "" : "+");
}

/** Where a shortcut step lands on the board: which key, and which modifiers are held. */
function place(step: string, platform: Platform): { key: string; mods: Modifier[] } {
  const s = parseShortcut(step)[0];
  const mac = platform === "macos";
  const held = new Set<Modifier>();
  if (s.ctrl || (s.mod && !mac)) held.add("ctrl");
  if (s.alt) held.add("alt");
  if (s.shift) held.add("shift");
  if (s.meta || (s.mod && mac)) held.add("meta");
  let key = s.key;
  if (SHIFTED[key]) {
    key = SHIFTED[key];
    held.add("shift");
  }
  return { key, mods: MODIFIERS.filter((m) => held.has(m)) };
}

/**
 * The commands' shortcuts sorted into layers for drawing on a keyboard. The plain layer always
 * exists; other layers only when some shortcut uses them. Shortcuts that don't parse are skipped.
 */
export function buildKeyboardMap(commands: Command[], platform: Platform): MapLayer[] {
  const layers = new Map<string, MapLayer>();
  const layer = (
    mods: Modifier[],
    prefix: string | null = null,
    first: { key: string; parent: MapLayer } | null = null,
  ) => {
    const id = layerIdFor(mods, prefix);
    let found = layers.get(id);
    if (!found) {
      const label = prefix
        ? `${describeShortcut(prefix, platform)} then ${modsLabel(mods, platform)}…`.replace(
            " …",
            "…",
          )
        : modsLabel(mods, platform) || "No modifier";
      found = {
        id,
        label,
        mods,
        prefix,
        prefixKey: first?.key ?? null,
        parent: first?.parent.id ?? null,
        bindings: new Map(),
        prefixes: new Map(),
      };
      layers.set(id, found);
    }
    return found;
  };
  layer([]);

  for (const command of commands) {
    if (!command.shortcut) continue;
    const steps = command.shortcut.trim().split(/\s+/);
    let target: MapLayer;
    let last: { key: string; mods: Modifier[] };
    try {
      last = place(steps[steps.length - 1], platform);
      if (steps.length === 1) target = layer(last.mods);
      else {
        const prefix = steps.slice(0, -1).join(" ");
        // Only a one-step prefix gets a key to click; longer ones are reached by their chip.
        const first = steps.length === 2 ? place(steps[0], platform) : null;
        const parent = first ? layer(first.mods) : null;
        target = layer(last.mods, prefix, first && parent && { key: first.key, parent });
        // "g i" and "g shift+i" share the G key: it opens the layer without Shift.
        if (first && parent && (!parent.prefixes.has(first.key) || !last.mods.length))
          parent.prefixes.set(first.key, target.id);
      }
    } catch {
      continue;
    }
    target.bindings.set(last.key, [...(target.bindings.get(last.key) ?? []), command]);
  }

  const weight = (l: MapLayer) => l.mods.reduce((w, m) => w + 2 ** MODIFIERS.indexOf(m), 0);
  const rank = (l: MapLayer) => [l.prefix === null ? 0 : 1, l.mods.length, weight(l)];
  return [...layers.values()].sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2] || a.label.localeCompare(b.label);
  });
}

/** How many commands a layer holds. */
export const layerSize = (l: MapLayer) =>
  [...l.bindings.values()].reduce((n, list) => n + list.length, 0);
