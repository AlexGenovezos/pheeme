import { describe, expect, test } from "vitest";
import { createPreviewHandlers } from "./install";

// Commands the browser preview deliberately leaves unanswered (it logs and returns null).
const NOT_FAKED: Record<string, string> = {};

// The source of every file outside tests and the preview (which holds the fakes themselves).
const SOURCES = import.meta.glob<string>(
  ["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}", "!../preview/**"],
  { query: "?raw", import: "default", eager: true },
);

/** Every command name passed to `call("…")` (or a raw `invoke("…")`). */
function invokedCommands(): Set<string> {
  const found = new Set<string>();
  for (const source of Object.values(SOURCES)) {
    for (const match of source.matchAll(/(?<![.\w])(?:call|invoke)(?:<[^(]*>)?\(\s*"([^"]+)"/g)) {
      found.add(match[1]);
    }
  }
  return found;
}

describe("browser preview", () => {
  test("answers every command the app invokes, except the listed ones", () => {
    const handlers = createPreviewHandlers();
    const commands = invokedCommands();
    expect(commands.size).toBeGreaterThan(100);
    const missing = [...commands].filter((c) => !(c in handlers) && !(c in NOT_FAKED)).sort();
    expect(missing).toEqual([]);
  });

  test("lists no command that is faked or no longer invoked", () => {
    const handlers = createPreviewHandlers();
    const commands = invokedCommands();
    const stale = Object.keys(NOT_FAKED).filter((c) => c in handlers || !commands.has(c));
    expect(stale).toEqual([]);
  });

  test("a mod connection is connected, then disconnected", () => {
    const handlers = createPreviewHandlers("?mods=1");
    const args = { id: "example.counter", connection: "google", clientId: "1.apps" };
    expect(handlers.mod_connection_status(args)).toBe(false);
    handlers.connect_mod(args);
    expect(handlers.mod_connection_status(args)).toBe(true);
    handlers.disconnect_mod(args);
    expect(handlers.mod_connection_status(args)).toBe(false);
  });
});
