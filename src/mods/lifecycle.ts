import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { toast } from "../components/ui/Toast";
import { findConflicts } from "../keyboard/bindings";
import { parseShortcut } from "../keyboard/registry";
import { useCommandList, useCommands } from "../keyboard/useCommands";
import { stopQuietly, toCommandError } from "../lib/tauri";
import { modAction } from "./api";
import { useModStore } from "./store";

export function useModEvents() {
  useEffect(() => {
    let stopped = false;
    let stop: (() => void) | undefined;
    // Subscribe before taking the initial snapshot so startup updates are retained.
    void listen("mods:changed", () => {
      void useModStore.getState().load();
    }).then(
      (off) => {
        if (stopped) stopQuietly(off);
        else {
          stop = off;
          void useModStore.getState().load();
        }
      },
      () => {
        if (!stopped) void useModStore.getState().load();
      },
    );
    return () => {
      stopped = true;
      if (stop) stopQuietly(stop);
    };
  }, []);
}

export function reportModError(error: unknown) {
  toast({ title: toCommandError(error).message, tone: "danger" });
}

export function useModCommands() {
  const mods = useModStore((s) => s.mods);
  const registered = useCommandList();
  const occupied = registered.filter((c) => !c.id.startsWith("mod:"));
  const commands = mods
    .filter((m) => m.running)
    .flatMap((mod) =>
      mod.manifest.commands.map((command) => {
        const id = `mod:${mod.manifest.id}:${command.id}`;
        let shortcut = command.shortcut ?? undefined;
        try {
          if (
            shortcut &&
            (!parseShortcut(shortcut).length || findConflicts(shortcut, occupied, id).length)
          )
            shortcut = undefined;
        } catch {
          shortcut = undefined;
        }
        const entry = {
          id,
          title: command.title,
          group: mod.manifest.name,
          shortcut,
          run: () => {
            void modAction(mod.manifest.id, command.id)
              .then(() => useModStore.getState().load())
              .catch(reportModError);
          },
        };
        occupied.push(entry);
        return entry;
      }),
    );
  useCommands(commands);
}
