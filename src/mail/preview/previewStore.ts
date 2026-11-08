import { create } from "zustand";
import type { AttachmentInfo } from "../../lib/tauri";

export interface PreviewSession {
  accountId: string;
  messageId: string;
  /** The message's files (inline images left out), in the order the list shows them. */
  files: AttachmentInfo[];
  index: number;
}

interface PreviewState {
  session: PreviewSession | null;
  open(session: PreviewSession): void;
  /** Move to the next (+1) or previous (-1) file, wrapping around. */
  step(delta: number): void;
  close(): void;
}

export const usePreviewStore = create<PreviewState>((set, get) => ({
  session: null,
  open: (session) => set({ session }),
  step: (delta) => {
    const s = get().session;
    if (!s || s.files.length < 2) return;
    const n = s.files.length;
    set({ session: { ...s, index: (((s.index + delta) % n) + n) % n } });
  },
  close: () => set({ session: null }),
}));
