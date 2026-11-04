import { create } from "zustand";
import { listMods, type ModSnapshot } from "./api";
import { toCommandError } from "../lib/tauri";

interface ModState extends ModSnapshot {
  loaded: boolean;
  error: string | null;
  panel: string | null;
  load(): Promise<void>;
  openPanel(id: string | null): void;
}

// Coalesce notifications while loading, and always fetch once more if a newer
// notification arrived in flight. An older snapshot cannot win a request race.
let loading: Promise<void> | null = null;
let again = false;
export const useModStore = create<ModState>((set) => ({
  safeMode: false,
  mods: [],
  loaded: false,
  error: null,
  panel: null,
  openPanel: (panel) => set({ panel }),
  load() {
    again = true;
    if (loading) return loading;
    loading = (async () => {
      do {
        again = false;
        try {
          const snapshot = await listMods();
          set((state) => ({
            ...snapshot,
            loaded: true,
            error: null,
            panel: snapshot.mods.some((m) => m.running && m.manifest.id === state.panel)
              ? state.panel
              : null,
          }));
        } catch (error) {
          set({ loaded: true, error: toCommandError(error).message });
        }
      } while (again);
    })().finally(() => {
      loading = null;
    });
    return loading;
  },
}));
