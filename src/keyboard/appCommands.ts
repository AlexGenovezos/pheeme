import { toast } from "../components/ui/Toast";
import { archive, labelMenuAnchor, openFocused, openLabelMenu, setRead, toggleStar, trash } from "../mail/actions";
import { CATEGORIES, categoryMailbox, FAVORITES, homeMailbox, resolveActiveAccount } from "../mail/mailboxes";
import { usePaletteStore } from "../palette/paletteStore";
import { useAccountStore } from "../store/accountStore";
import { useUiStore } from "../store/uiStore";
import { useThemeStore } from "../theme/theme";
import type { Command } from "./registry";
import { useCommands } from "./useCommands";

const composeLater = () => toast({ title: "Compose arrives with Phase 7" });

/** App-wide commands. Pane-specific ones (j/k, search, selection) register in their panes. */
export function appCommands(): Command[] {
  const theme = () => useThemeStore.getState();
  const ui = () => useUiStore.getState();
  const accounts = () => useAccountStore.getState().accounts;
  // Favorites and categories open in the account the sidebar is showing them for.
  const activeAccount = () => resolveActiveAccount(ui().activeAccountId, accounts());
  return [
    {
      id: "palette.toggle",
      title: "Show all commands",
      group: "General",
      shortcut: "mod+k",
      global: true,
      hidden: true,
      run: () => usePaletteStore.getState().toggle(),
    },
    {
      id: "go.inbox",
      title: "Go to Inbox",
      group: "Navigation",
      shortcut: "g i",
      keywords: ["all inboxes"],
      run: () => ui().setMailbox(homeMailbox(accounts())),
    },
    ...CATEGORIES.map<Command>((c) => ({
      id: `go.category.${c.name.toLowerCase()}`,
      title: `Go to ${c.name}`,
      group: "Navigation",
      keywords: ["inbox", "category"],
      run: () => {
        const id = activeAccount();
        if (id) ui().setMailbox(categoryMailbox(id, c.labelId));
      },
    })),
    ...FAVORITES.map<Command>((f) => ({
      id: `go.${f.labelId.toLowerCase()}`,
      title: `Go to ${f.name}`,
      group: "Navigation",
      shortcut: f.goKey ? `g ${f.goKey}` : undefined,
      run: () => {
        const id = activeAccount();
        if (id) ui().setMailbox({ accountId: id, labelId: f.labelId });
      },
    })),
    { id: "conversation.archive", title: "Archive", group: "Conversation", shortcut: "e", run: () => void archive() },
    { id: "conversation.delete", title: "Delete", group: "Conversation", shortcut: "#", keywords: ["trash"], run: () => void trash() },
    { id: "conversation.star", title: "Star or unstar", group: "Conversation", shortcut: "s", run: () => void toggleStar() },
    { id: "conversation.mark-unread", title: "Mark as unread", group: "Conversation", shortcut: "shift+u", run: () => void setRead(false) },
    { id: "conversation.mark-read", title: "Mark as read", group: "Conversation", shortcut: "shift+i", run: () => void setRead(true) },
    {
      id: "conversation.labels",
      title: "Label as…",
      group: "Conversation",
      shortcut: "l",
      keywords: ["tag"],
      run: () => void openLabelMenu(labelMenuAnchor()),
    },
    { id: "conversation.open", title: "Open conversation", group: "Conversation", shortcut: "o", run: openFocused },
    { id: "conversation.close", title: "Close conversation", group: "Conversation", shortcut: "u", run: () => ui().setOpenThread(null) },
    { id: "conversation.reply", title: "Reply", group: "Conversation", shortcut: "r", run: composeLater },
    { id: "conversation.reply-all", title: "Reply all", group: "Conversation", shortcut: "a", run: composeLater },
    { id: "conversation.forward", title: "Forward", group: "Conversation", shortcut: "f", run: composeLater },
    {
      id: "view.toggleSidebar",
      title: "Toggle sidebar",
      group: "View",
      shortcut: "mod+b",
      keywords: ["hide", "show", "panel"],
      run: () => ui().toggleSidebar(),
    },
    {
      id: "theme.toggle",
      title: "Toggle light and dark theme",
      group: "Appearance",
      shortcut: "mod+shift+l",
      keywords: ["theme", "dark mode", "light mode", "appearance"],
      run: () => theme().toggle(),
    },
    {
      id: "theme.system",
      title: "Theme: Match system",
      group: "Appearance",
      keywords: ["auto", "os"],
      run: () => theme().setMode("system"),
    },
    { id: "theme.light", title: "Theme: Light", group: "Appearance", run: () => theme().setMode("light") },
    { id: "theme.dark", title: "Theme: Dark", group: "Appearance", run: () => theme().setMode("dark") },
  ];
}

export function useAppCommands() {
  useCommands(appCommands());
}
