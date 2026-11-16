import { invoke } from "@tauri-apps/api/core";
import type { Commands } from "./commands";

/** Every command rejects with this shape: a stable code and a plain-language message. */
export interface CommandError {
  code: string;
  message: string;
}

export function toCommandError(error: unknown): CommandError {
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as CommandError).code === "string" &&
    typeof (error as CommandError).message === "string"
  ) {
    return error as CommandError;
  }
  return { code: "internal", message: `Something went wrong: ${String(error)}` };
}

/** The arguments of a call: none for a command that takes none, else the one object. */
type CallArgs<K extends keyof Commands> = Commands[K]["args"] extends void
  ? []
  : [args: Commands[K]["args"]];

/**
 * Invoke a Rust command by name. The name, its arguments and its result are checked against
 * `Commands`, the one list of the IPC surface, which the browser preview's fakes are held to as well.
 */
export function call<K extends keyof Commands>(
  name: K,
  ...args: CallArgs<K>
): Promise<Commands[K]["result"]> {
  return invoke<Commands[K]["result"]>(name, args[0] as Record<string, unknown> | undefined);
}
