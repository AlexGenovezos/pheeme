import { create } from "zustand";

export interface PersonTarget {
  address: string;
  name: string | null;
}

/** The person card on screen, opened from a sender or recipient in Mail or a guest in Calendar. */
interface PersonState {
  open: { accountId: string; person: PersonTarget } | null;
  show(accountId: string, person: PersonTarget): void;
  close(): void;
}

export const usePersonStore = create<PersonState>((set) => ({
  open: null,
  show: (accountId, person) => set({ open: { accountId, person } }),
  close: () => set({ open: null }),
}));

export const showPerson = (accountId: string, person: PersonTarget) =>
  usePersonStore.getState().show(accountId, person);
