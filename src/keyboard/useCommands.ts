import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { registry, type Command, type CommandRegistry } from "./registry";

/** Every registered command, re-rendering when the set changes. */
export function useCommandList(reg: CommandRegistry = registry): Command[] {
  return useSyncExternalStore(reg.subscribe, reg.list, reg.list);
}

/** The chord prefix typed so far ("g"), for the on-screen hint. */
export function usePendingChord(reg: CommandRegistry = registry): string | null {
  return useSyncExternalStore(reg.subscribe, reg.pendingChord, reg.pendingChord);
}

/**
 * Register commands for as long as the calling component is mounted.
 * `run` always calls the latest closure, so callers needn't memoize.
 */
export function useCommands(commands: Command[], reg: CommandRegistry = registry) {
  const latest = useRef(commands);
  useLayoutEffect(() => {
    latest.current = commands;
  });
  const signature = commands
    .map((c) =>
      [c.id, c.title, c.group, c.shortcut, c.global, c.hidden, c.keywords?.join(" ")].join("|"),
    )
    .join("\n");

  useEffect(() => {
    const offs = latest.current.map((c) =>
      reg.register({ ...c, run: () => latest.current.find((x) => x.id === c.id)?.run() }),
    );
    return () => offs.forEach((off) => off());
    // `signature` captures everything about the commands except `run`, which goes through the ref.
  }, [signature, reg]);
}

/** Route window keydowns into the registry. Mount once, at the app root. */
export function useGlobalShortcuts(reg: CommandRegistry = registry) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => void reg.handleKeyDown(e);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [reg]);
}

/**
 * The shortcut to label a button or menu item with for command `id`: the user's binding, else the
 * default. `fallback` covers labels drawn while the command isn't registered.
 */
export function useKeybinding(
  id: string,
  fallback?: string,
  reg: CommandRegistry = registry,
): string | undefined {
  const read = () => reg.shortcutFor(id, fallback);
  return useSyncExternalStore(reg.subscribe, read, read);
}
