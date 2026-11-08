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

/** Which reply button comes first, and stands out, above a conversation. */
export type DefaultReply = "reply" | "replyAll";
export const DEFAULT_REPLY: DefaultReply = "reply";

const REPLY_KEY = "pheeme.default-reply";
const CONFIRM_KEY = "pheeme.confirm-send";

function readReply(): DefaultReply {
  return storage()?.getItem(REPLY_KEY) === "replyAll" ? "replyAll" : DEFAULT_REPLY;
}

function readConfirm(): boolean {
  return storage()?.getItem(CONFIRM_KEY) === "true";
}

function persist(key: string, value: string) {
  try {
    storage()?.setItem(key, value);
  } catch {
    // The choice just won't survive a relaunch.
  }
}

interface ComposeSettings {
  undoSendSeconds: UndoSendSeconds;
  setUndoSendSeconds(seconds: UndoSendSeconds): void;
  defaultReply: DefaultReply;
  setDefaultReply(reply: DefaultReply): void;
  /** Ask "Send this message?" before each send. */
  confirmSend: boolean;
  setConfirmSend(confirm: boolean): void;
}

export const useComposeSettings = create<ComposeSettings>((set) => ({
  undoSendSeconds: read(),
  setUndoSendSeconds: (seconds) => {
    persist(KEY, String(seconds));
    set({ undoSendSeconds: seconds });
  },
  defaultReply: readReply(),
  setDefaultReply: (reply) => {
    persist(REPLY_KEY, reply);
    set({ defaultReply: reply });
  },
  confirmSend: readConfirm(),
  setConfirmSend: (confirm) => {
    persist(CONFIRM_KEY, String(confirm));
    set({ confirmSend: confirm });
  },
}));

/** Test helper: re-read the stored choices. */
export function __resetComposeSettingsForTests() {
  useComposeSettings.setState({
    undoSendSeconds: read(),
    defaultReply: readReply(),
    confirmSend: readConfirm(),
  });
}
