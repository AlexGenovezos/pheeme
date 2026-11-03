import { CATEGORIES, categoryMailbox, FAVORITES, homeMailbox, resolveActiveAccount } from "../mail/mailboxes";
import { usePaletteStore } from "../palette/paletteStore";
import { useAccountStore } from "../store/accountStore";
import { useUiStore } from "../store/uiStore";
import { useThemeStore } from "../theme/theme";
import type { Command } from "./registry";
import { useCommands } from "./useCommands";

/** App-wide commands. Pane-specific ones (j/k, search) register in their panes. */
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
