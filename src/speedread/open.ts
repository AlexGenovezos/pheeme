import { useMemo } from "react";
import { create } from "zustand";
import { toast } from "../components/ui/Toast";
import type { MessageDetail, ThreadDetail } from "../lib/tauri";
import { useThreadStore } from "../store/threadStore";
import { useUiStore } from "../store/uiStore";
import { speedReadText } from "./text";

export interface SpeedReadSession {
  /** Identifies the message, so reopening the same one starts over cleanly. */
  id: string;
  title: string;
  paragraphs: string[];
}

interface SpeedReaderState {
  session: SpeedReadSession | null;
  open(session: SpeedReadSession): void;
  close(): void;
}

export const useSpeedReader = create<SpeedReaderState>((set) => ({
  session: null,
  open: (session) => set({ session }),
  close: () => set({ session: null }),
}));

/** The newest message in the conversation that's simple enough to speed read, with its text. */
export function readableMessage(
  detail: ThreadDetail | undefined,
): { message: MessageDetail; paragraphs: string[] } | null {
  if (!detail) return null;
  for (let i = detail.messages.length - 1; i >= 0; i--) {
    const message = detail.messages[i];
    if (message.labelIds.includes("DRAFT")) continue;
    const paragraphs = speedReadText(message);
    if (paragraphs) return { message, paragraphs };
  }
  return null;
}

/** The readable message in the open conversation, if there is one; re-renders as the conversation loads. */
export function useReadableMessage() {
  const key = useUiStore((s) => s.openThread);
  const detail = useThreadStore((s) => (key ? s.details.get(key) : undefined));
  return useMemo(() => readableMessage(detail), [detail]);
}

/** Open the speed reader on the open conversation (the `conversation.speed-read` command and button). */
export function speedReadOpenConversation() {
  const key = useUiStore.getState().openThread;
  const detail = key ? useThreadStore.getState().details.get(key) : undefined;
  const found = readableMessage(detail);
  if (!found) {
    toast({
      title: "Nothing to speed read",
      description: "The speed reader works on emails that are mostly plain text.",
    });
    return;
  }
  const { message, paragraphs } = found;
  useSpeedReader.getState().open({
    id: message.id,
    title: message.subject || detail?.thread.subject || "(no subject)",
    paragraphs,
  });
}
