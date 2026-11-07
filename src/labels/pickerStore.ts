// Which label picker is open: "Label as…" (tick labels on and off) or "Move to…" (choose where the mail goes).
import { create } from "zustand";
import type { ThreadKey } from "../mail/mailboxes";

/** Whether all, some or none of the picker's conversations carry a label. */
export type Membership = "all" | "some" | "none";

export interface PickerSpec {
  mode: "label" | "move";
  accountId: string;
  /** The conversations it acts on, all from `accountId`. Empty: the picker only creates labels. */
  keys: ThreadKey[];
  /** Viewport coordinates of its top-left corner (clamped to stay on screen). */
  at: { x: number; y: number };
  /** Per user-label id, `label` mode only; missing ids are `none`. */
  membership?: Map<string, Membership>;
}

interface PickerState {
  /** `seq` changes per open, so a re-opened picker starts fresh. */
  spec: (PickerSpec & { seq: number }) | null;
  open(spec: PickerSpec): void;
  close(): void;
}

let seq = 0;

export const usePickerStore = create<PickerState>((set) => ({
  spec: null,
  open: (spec) => set({ spec: { ...spec, seq: ++seq } }),
  close: () => set({ spec: null }),
}));
