// Which label dialog is open: create/edit a label, or confirm deleting one.
import { create } from "zustand";
import type { ThreadKey } from "../mail/mailboxes";

export type LabelDialogSpec =
  | {
      mode: "create";
      accountId: string;
      /** Prefilled name; a `/` splits it into parent (if that label exists) and leaf. */
      name?: string;
      /** Prefilled parent, a full path. */
      parent?: string;
      /** Conversations to label once it exists. */
      applyTo?: ThreadKey[];
      /** With `applyTo`: move them to the new label (the "Move to…" picker) instead of just labelling them. */
      move?: boolean;
    }
  | { mode: "edit"; accountId: string; labelId: string };

export type DialogState =
  | { kind: "label"; spec: LabelDialogSpec; seq: number }
  | { kind: "delete"; accountId: string; labelId: string; seq: number }
  | null;

interface DialogStore {
  dialog: DialogState;
  close(): void;
}

let seq = 0;

export const useLabelDialogStore = create<DialogStore>((set) => ({
  dialog: null,
  close: () => set({ dialog: null }),
}));

export function openLabelDialog(spec: LabelDialogSpec): void {
  useLabelDialogStore.setState({ dialog: { kind: "label", spec, seq: ++seq } });
}

export function openDeleteLabel(accountId: string, labelId: string): void {
  useLabelDialogStore.setState({ dialog: { kind: "delete", accountId, labelId, seq: ++seq } });
}
