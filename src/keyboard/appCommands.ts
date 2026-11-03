import { usePaletteStore } from "../palette/paletteStore";
import { fixtureMailboxes } from "../preview/fixtures";
import { useUiStore } from "../store/uiStore";
import { useThemeStore } from "../theme/theme";
import type { Command } from "./registry";
import { useCommands } from "./useCommands";

/** App-wide commands. Pane-specific ones (j/k, search) register in their panes. */
export function appCommands(): Command[] {
  const theme = () => useThemeStore.getState();
  const ui = () => useUiStore.getState();
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
    ...fixtureMailboxes
      .filter((m) => m.goKey)
      .map<Command>((m) => ({
        id: `go.${m.id.toLowerCase()}`,
        title: `Go to ${m.name}`,
        group: "Navigation",
        shortcut: `g ${m.goKey}`,
        run: () => ui().setActiveMailbox(m.id),
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
    {
      id: "theme.light",
      title: "Theme: Light",
      group: "Appearance",
      run: () => theme().setMode("light"),
    },
    {
      id: "theme.dark",
      title: "Theme: Dark",
      group: "Appearance",
      run: () => theme().setMode("dark"),
    },
  ];
}

export function useAppCommands() {
  useCommands(appCommands());
}
