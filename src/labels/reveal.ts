// "Manage labels": opens the sidebar on its Labels section, which takes focus once it has rendered.
import { create } from "zustand";
import { sidebarLayout, useUiStore } from "../store/uiStore";

/** A pending reveal for the sidebar's Labels section to act on; `0` when there is none. */
export const useRevealStore = create<{ pending: number }>(() => ({ pending: 0 }));

let seq = 0;

/**
 * Expands the sidebar if it's collapsed, scrolls the Labels section into view and focuses its first row. With
 * `accountId`, the sidebar switches to that account's labels first (the mailbox shown stays as it is).
 */
export function revealLabels(accountId?: string): void {
  const ui = useUiStore.getState();
  if (accountId) ui.setActiveAccount(accountId);
  // Hidden by the user or for lack of room: open it (over the content when there's no room).
  if (sidebarLayout(ui) === "collapsed") ui.toggleSidebar();
  useRevealStore.setState({ pending: ++seq });
}
