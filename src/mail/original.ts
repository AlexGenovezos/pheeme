// Show original, as Gmail has it: a message's own source (headers, every part), with the summary a person
// checks first (who it says it's from, when, and whether SPF, DKIM and DMARC passed). The conversation's menu
// and the palette show the latest message's, the message's own menu that message's. Rust fetches it from Gmail
// each time (`src-tauri/src/mail/original.rs`), so it needs a connection.
import { create } from "zustand";
import { toast } from "../components/ui/Toast";
import { revealDownload, saveOriginal, toCommandError } from "../lib/tauri";
import { useThreadStore } from "../store/threadStore";
import { useUiStore } from "../store/uiStore";
import { parseThreadKey } from "./mailboxes";

export const SHOW_ORIGINAL_COMMAND = "conversation.show-original";

interface OriginalState {
  /** The message whose source is open. */
  open: { accountId: string; messageId: string } | null;
}

export const useOriginalStore = create<OriginalState>(() => ({ open: null }));

export function showOriginal(accountId: string, messageId: string) {
  useOriginalStore.setState({ open: { accountId, messageId } });
}

export function closeOriginal() {
  useOriginalStore.setState({ open: null });
}

/** The conversation's Show original (More menu, palette): the conversation's latest message. */
export async function showOriginalOfOpenConversation() {
  const key = useUiStore.getState().openThread;
  if (!key) {
    toast({ title: "Open a conversation to see its original." });
    return;
  }
  let detail = useThreadStore.getState().details.get(key);
  if (!detail) {
    await useThreadStore.getState().load(key);
    detail = useThreadStore.getState().details.get(key);
  }
  const latest = detail?.messages[detail.messages.length - 1]?.id;
  if (!latest) {
    toast({ title: "That message couldn't be found.", tone: "danger" });
    return;
  }
  showOriginal(parseThreadKey(key).accountId, latest);
}

/** Download original: save the `.eml` to Downloads and say so, with a way to show it in the file manager. */
export async function downloadOriginal(accountId: string, messageId: string): Promise<void> {
  try {
    const path = await saveOriginal(accountId, messageId);
    toast({
      title: "Saved to Downloads",
      description: path.split(/[\\/]/).pop(),
      action: {
        label: "Show in folder",
        run: () =>
          void revealDownload(path).catch((e) =>
            toast({
              title: "Couldn't show the file",
              description: toCommandError(e).message,
              tone: "danger",
            }),
          ),
      },
    });
  } catch (error) {
    toast({
      title: "Couldn't save the original",
      description: toCommandError(error).message,
      tone: "danger",
    });
  }
}
