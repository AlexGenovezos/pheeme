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

const notDraft = (message: MessageDetail) => !message.labelIds.includes("DRAFT");

/**
 * The message to speed read: `inView` (the one the reader is looking at) when it's in the conversation,
 * otherwise the newest. Never another one: falling back to an older email that happens to be readable
 * starts the reader somewhere the user didn't ask for.
 */
export function readableMessage(
  detail: ThreadDetail | undefined,
  inView: string | null = null,
): { message: MessageDetail; paragraphs: string[] } | null {
  const messages = detail?.messages.filter(notDraft) ?? [];
  const message = messages.find((m) => m.id === inView) ?? messages[messages.length - 1];
  const paragraphs = message ? speedReadText(message) : null;
  return message && paragraphs ? { message, paragraphs } : null;
}

/** Whether any message in the open conversation can be speed read; re-renders as the conversation loads. */
export function useCanSpeedRead(enabled = true) {
  const key = useUiStore((s) => (enabled ? s.openThread : null));
  const detail = useThreadStore((s) => (key ? s.details.get(key) : undefined));
  return useMemo(() => !!detail?.messages.some((m) => notDraft(m) && speedReadText(m)), [detail]);
}

/** How much of a card must still show for it to count as on screen, not just its bottom edge. */
const IN_VIEW_MIN = 48;

/**
 * The expanded message the reader is looking at in the reading pane: the first whose card is still on screen,
 * so scrolling down into a long one keeps it.
 */
export function messageInView(): string | null {
  const pane = document.querySelector(".view-pane__scroll");
  if (!pane) return null;
  const view = pane.getBoundingClientRect();
  const cards = pane.querySelectorAll<HTMLElement>(
    '.thread-view__retained[data-visible="true"] [data-message-id]',
  );
  for (const card of cards) {
    const box = card.getBoundingClientRect();
    if (box.bottom > view.top + IN_VIEW_MIN && box.top < view.bottom) {
      return card.dataset.messageId ?? null;
    }
  }
  return null;
}

/** Open the speed reader on the open conversation (the `conversation.speed-read` command and button). */
export function speedReadOpenConversation() {
  const key = useUiStore.getState().openThread;
  const detail = key ? useThreadStore.getState().details.get(key) : undefined;
  const found = readableMessage(detail, messageInView());
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
