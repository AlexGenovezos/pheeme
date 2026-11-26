// @vitest-environment node
import { API, type Project, SymbolFlags } from "typescript/unstable/sync";
import { expect, test } from "vitest";
import handlers from "../../../src-tauri/src/lib.rs?raw";
import events from "../../../src-tauri/src/sync/events.rs?raw";

// Let TypeScript resolve the computed keys in AppEvents, including string constants.
function interfaceKeys(project: Project, file: string, name: string) {
  const source = project.program.getSourceFile(`src/lib/ipc/${file}.ts`)!;
  const symbol = project.checker.resolveName(name, SymbolFlags.Type, source)!;
  const type = project.checker.getDeclaredTypeOfSymbol(symbol);
  return project.checker.getPropertiesOfType(type).map((property) => property.name);
}

test("registered Rust commands and sync event names match the window's IPC contract", () => {
  const api = new API();
  try {
    const config = "tsconfig.json";
    const project = api.updateSnapshot({ openProjects: [config] }).getProject(config)!;
    const handlerList = handlers.match(/tauri::generate_handler!\s*\[([^\]]+)\]/)![1];
    const commands = handlerList
      .split(",")
      .map((path) => path.trim())
      .filter(Boolean)
      .map((path) => path.split("::").pop());
    expect(commands.sort()).toEqual(interfaceKeys(project, "commands", "Commands").sort());

    const nameFunction = events.match(/pub fn name\(&self\)[\s\S]*?\n {4}\}/)![0];
    // Each match arm returns a string literal. An unfamiliar expression should fail the test.
    const sync = nameFunction
      .split("=>")
      .slice(1)
      .map((arm) => arm.trimStart().match(/^"([^"]+)"/)![1]);
    // These events originate at the app, desktop, menu and quit emitters outside SyncEvent.
    const direct = [
      "assistant:activity",
      "mods:changed",
      "desktop:open-thread",
      "desktop:error",
      "check-for-updates",
      "compose:save_before_exit",
    ];
    // The desktop notification service consumes new mail. The window has no listener for it.
    const windowEvents = interfaceKeys(project, "events", "AppEvents");
    expect([...sync, ...direct].sort()).toEqual([...windowEvents, "sync:new_mail"].sort());
  } finally {
    api.close();
  }
});
