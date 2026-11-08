// Asks App to show the setup guide (the onboarding flow); the palette command has no other way to reach it.
import { create } from "zustand";

type SetupGuide = { requested: number; open: () => void };

export const useSetupGuide = create<SetupGuide>((set) => ({
  requested: 0,
  open: () => set((s) => ({ requested: s.requested + 1 })),
}));
