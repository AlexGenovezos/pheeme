import { create } from "zustand";

export const STATS_TABS = ["overview", "places", "senders"] as const;
export type StatsTab = (typeof STATS_TABS)[number];

interface StatsState {
  open: boolean;
  /** The view showing; kept between openings. */
  tab: StatsTab;
  openStats(tab?: StatsTab): void;
  close(): void;
  setTab(tab: StatsTab): void;
}

export const useStatsStore = create<StatsState>((set) => ({
  open: false,
  tab: "overview",
  openStats: (tab) => set((s) => ({ open: true, tab: tab ?? s.tab })),
  close: () => set({ open: false }),
  setTab: (tab) => set({ tab }),
}));
