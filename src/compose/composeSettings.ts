import { create } from "zustand";

/** Seconds a sent message waits so it can be undone; 0 sends at once. */
export const UNDO_SEND_CHOICES = [0, 5, 10, 20, 30] as const;
export type UndoSendSeconds = (typeof UNDO_SEND_CHOICES)[number];
export const DEFAULT_UNDO_SEND: UndoSendSeconds = 5;

const KEY = "pheeme.undo-send-seconds";

function storage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function read(): UndoSendSeconds {
  const stored = Number(storage()?.getItem(KEY) ?? NaN);
  return (UNDO_SEND_CHOICES as readonly number[]).includes(stored)
    ? (stored as UndoSendSeconds)
    : DEFAULT_UNDO_SEND;
}

interface ComposeSettings {
  undoSendSeconds: UndoSendSeconds;
  setUndoSendSeconds(seconds: UndoSendSeconds): void;
}

export const useComposeSettings = create<ComposeSettings>((set) => ({
  undoSendSeconds: read(),
  setUndoSendSeconds: (seconds) => {
    try {
      storage()?.setItem(KEY, String(seconds));
    } catch {
      // The choice just won't survive a relaunch.
    }
    set({ undoSendSeconds: seconds });
  },
}));

/** Test helper: re-read the stored choice. */
export function __resetComposeSettingsForTests() {
  useComposeSettings.setState({ undoSendSeconds: read() });
}
