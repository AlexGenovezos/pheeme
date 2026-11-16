// Moving through the list and opening conversations from the keyboard.
import { useThreadStore } from "../store/threadStore";
import { sortsAfter } from "../store/mailStore";
import { focusedThread, readingPaneShown } from "../store/uiStore";
import { keyOf, mail, openAndMarkRead, present, ui } from "./change";
import type { ThreadKey } from "./mailboxes";

/**
 * j / k and the arrow keys: open the next or previous row, or the first/last when none is open. With the reading
 * pane off and nothing open, they move the highlight instead.
 */
export function moveSelection(delta: 1 | -1): void {
  const { threads } = mail();
  const keys = threads.map(keyOf);
  if (keys.length === 0) return;
  const browsing = !readingPaneShown(ui()) && ui().openThread === null;
  const current = focusedThread(ui());
  const at = current === null ? -1 : keys.indexOf(current);
  let to: number;
  if (at >= 0) to = Math.min(Math.max(at + delta, 0), keys.length - 1);
  else {
    // Not in the list (archived elsewhere, say): step from where it sorted, not from the top. Without its
    // summary there's nowhere to step from, so start from the end, as when nothing is open.
    const gone = current === null ? undefined : useThreadStore.getState().details.get(current);
    if (!gone) to = delta === 1 ? 0 : keys.length - 1;
    else {
      const cursor = {
        lastMessageDate: gone.thread.date,
        accountId: gone.thread.accountId,
        threadId: gone.thread.id,
      };
      const below = threads.findIndex((t) => sortsAfter(t, cursor));
      to = delta === 1 ? below : (below < 0 ? keys.length : below) - 1;
      if (to < 0) return;
    }
  }
  if (to === at) return;
  if (browsing) ui().setCursor(keys[to]);
  else openAndMarkRead(keys[to], delta);
}

/** The focused conversation, where a highlight whose row has left the list (filtered out, archived elsewhere) counts as nothing. */
function focusedInList(): ThreadKey | null {
  const focused = focusedThread(ui());
  if (focused !== null && ui().openThread === null && present([focused]).length === 0) return null;
  return focused;
}

/** `o` / Enter: open the focused conversation (or highlighted row), or the first one when nothing is. */
export function openFocused(): void {
  const focused = focusedInList();
  const first = mail().threads[0];
  if (focused !== null) openAndMarkRead(focused);
  else if (first) openAndMarkRead(keyOf(first));
}

/** `x`: check or uncheck the focused conversation (or highlighted row). */
export function toggleCheckFocused(): void {
  const focused = focusedInList();
  if (focused !== null) ui().toggleChecked(focused);
}

/** `u` / Back: close the conversation, leaving its row highlighted for when the reading pane is off. */
export function closeConversation(): void {
  const open = ui().openThread;
  if (open !== null) ui().setCursor(open);
  ui().setOpenThread(null);
}
