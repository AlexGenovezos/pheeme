import { create } from "zustand";

interface SettingsState {
  open: boolean;
  /** The page showing, by `SettingsPageDef.id`. */
  page: string;
  /** Open the dialog, on `page` if given, else where it was last left. */
  openSettings(page?: string): void;
  close(): void;
  setPage(page: string): void;
}

export const DEFAULT_SETTINGS_PAGE = "appearance";

export const useSettingsStore = create<SettingsState>((set) => ({
  open: false,
  page: DEFAULT_SETTINGS_PAGE,
  openSettings: (page) => set((s) => ({ open: true, page: page ?? s.page })),
  close: () => set({ open: false }),
  setPage: (page) => set({ page }),
}));
