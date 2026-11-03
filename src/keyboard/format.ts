import { platform as currentPlatform, type Platform } from "../lib/platform";
import { parseShortcut } from "./registry";

const NAMED: Record<string, string> = {
  escape: "Esc",
  enter: "Enter",
  " ": "Space",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  backspace: "Backspace",
  delete: "Delete",
  tab: "Tab",
};

const MAC_NAMED: Record<string, string> = { enter: "↩", backspace: "⌫", delete: "⌦", tab: "⇥" };

function keyLabel(key: string, platform: Platform) {
  if (platform === "macos" && MAC_NAMED[key]) return MAC_NAMED[key];
  return NAMED[key] ?? (key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1));
}

/**
 * Shortcut → key caps to draw, one array per chord step.
 * `"mod+shift+l"` → `[["⌘", "⇧", "L"]]` on macOS, `[["Ctrl", "Shift", "L"]]` elsewhere;
 * `"g i"` → `[["G"], ["I"]]`.
 */
export function formatShortcut(shortcut: string, platform: Platform = currentPlatform): string[][] {
  const mac = platform === "macos";
  return parseShortcut(shortcut).map((s) => {
    const caps: string[] = [];
    if (s.ctrl || (s.mod && !mac)) caps.push(mac ? "⌃" : "Ctrl");
    if (s.alt) caps.push(mac ? "⌥" : "Alt");
    if (s.shift) caps.push(mac ? "⇧" : "Shift");
    if (s.meta || (s.mod && mac)) caps.push(mac ? "⌘" : "Win");
    caps.push(keyLabel(s.key, platform));
    return caps;
  });
}

/** Spoken/plain form for aria-keyshortcuts-like labels and native menus: "Ctrl+K", "G then I". */
export function describeShortcut(shortcut: string, platform: Platform = currentPlatform): string {
  return formatShortcut(shortcut, platform)
    .map((caps) => caps.join(platform === "macos" ? "" : "+"))
    .join(" then ");
}
