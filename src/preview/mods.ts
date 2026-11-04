import type { ModInfo, PreparedMod } from "../mods/api";
import counterManifest from "../../examples/mods/counter/manifest.json";

type Args = Record<string, unknown> | undefined;

// Preview data only: untrusted mod code is never evaluated in the browser.
export function createModHandlers(params: URLSearchParams) {
  let count = 0;
  let title = "My counter";
  let compact = true;
  const mods: ModInfo[] = [];
  const counter = (): ModInfo => ({
    manifest: {
      ...counterManifest,
      commands: counterManifest.commands.map((c) => ({ ...c, shortcut: null })),
    },
    enabled: true,
    running: true,
    error: null,
    views: {
      settings: [
        { type: "input", id: "title", label: "Counter name", value: title },
        { type: "toggle", id: "compact", label: "Show count in sidebar", value: compact },
        { type: "button", id: "reset", label: "Reset counter", disabled: false },
      ],
      panel: [
        { type: "text", text: `${title}: ${count}` },
        { type: "button", id: "increment", label: "Add one", disabled: false },
      ],
      compact: compact
        ? [
            { type: "text", text: `${title}: ${count}` },
            { type: "button", id: "increment", label: "+1", disabled: false },
          ]
        : [],
    },
  });
  if (params.get("mods") === "1") mods.push(counter());
  let prepared: PreparedMod | null = null;
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  return {
    list_mods: () => copy({ safeMode: false, mods }),
    prepare_mod_install: () => {
      prepared = {
        ticket: "preview-counter",
        manifest: counter().manifest,
        replacing: mods.length > 0,
      };
      return copy(prepared);
    },
    discard_mod_install: () => {
      prepared = null;
    },
    install_mod: () => {
      if (!prepared) throw { code: "mod_error", message: "Choose a mod folder again" };
      mods.splice(0, mods.length, counter());
      prepared = null;
    },
    set_mod_enabled: (args: Args) => {
      const mod = mods.find((m) => m.manifest.id === args?.id);
      if (mod) {
        mod.enabled = args?.enabled === true;
        mod.running = mod.enabled;
      }
    },
    remove_mod: () => {
      mods.splice(0);
    },
    mod_action: (args: Args) => {
      if (!mods[0]?.running) throw { code: "mod_error", message: "Mod is not running" };
      if (args?.action === "increment") count++;
      if (args?.action === "reset") count = 0;
      if (args?.action === "title") title = String(args?.value);
      if (args?.action === "compact") compact = args?.value === true;
      mods[0] = counter();
    },
    mod_connection_status: () => false,
  };
}
