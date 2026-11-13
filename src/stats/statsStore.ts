import { create } from "zustand";

interface StatsState {
  open: boolean;
  openStats(): void;
  close(): void;
}

export const useStatsStore = create<StatsState>((set) => ({
  open: false,
  openStats: () => set({ open: true }),
  close: () => set({ open: false }),
}));
