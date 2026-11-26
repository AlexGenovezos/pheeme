import type { Commands } from "../lib/ipc/commands";

/** How the preview answers command `K`: given the arguments the real wrapper sends, what it resolves to. */
export type Handler<K extends keyof Commands> = (
  args: Commands[K]["args"],
) => Commands[K]["result"] | Promise<Commands[K]["result"]>;

/** A fake for some of the commands; each preview file answers its own and `install.ts` joins them. */
export type PartialHandlers = { [K in keyof Commands]?: Handler<K> };

/** A fake for every command: adding a command to `Commands` fails typecheck until the preview answers it. */
export type CommandHandlers = { [K in keyof Commands]: Handler<K> };

/** Handlers for Tauri plugins, which own their commands separately from the app. */
export interface PluginHandlers {
  "plugin:dialog|open": () => string[];
  "plugin:dialog|save": () => string;
  "plugin:updater|check": () => null;
}

/** Everything the browser preview answers when the window invokes a command by name. */
export type PreviewHandlers = CommandHandlers & PluginHandlers;

/** Handlers as the IPC mock finds them, by the command name it was given (`undefined` for one nobody fakes). */
export function byName(
  handlers: object,
): Record<string, ((args?: unknown) => unknown) | undefined> {
  return handlers as Record<string, ((args?: unknown) => unknown) | undefined>;
}
