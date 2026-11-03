import type { ThemeDefinition } from "./schema";

/**
 * Pheeme Light. Cool mineral greys with one accent, verdigris: the patina on
 * the bronze trumpet Pheme carries. The accent is spent on selection, focus
 * and unread state only, so it always means "this one".
 *
 * Keep --color-app-bg in sync with the critical style in index.html
 * (theme.test.ts checks it).
 */
export const lightTheme: ThemeDefinition = {
  id: "pheeme-light",
  name: "Pheeme Light",
  kind: "light",
  tokens: {
    "--color-app-bg": "#ffffff",
    "--color-pane-bg": "#ffffff",
    "--color-sidebar-bg": "#f2f4f4",
    "--color-sidebar-foreground": "#2e3535",
    "--color-titlebar-bg": "#ffffff",
    "--color-pane-border": "#e2e6e6",
    "--color-border": "#d3d9d9",
    "--color-border-subtle": "#e9ecec",

    "--color-foreground": "#1a1f1f",
    "--color-foreground-muted": "#586262",
    "--color-foreground-subtle": "#8a9494",
    "--color-link": "#1d6f69",
    "--color-selection-bg": "#bfe3df",

    "--color-accent": "#1d6f69",
    "--color-accent-hover": "#175c57",
    "--color-accent-foreground": "#ffffff",
    "--color-focus-border": "#2a8c84",
    "--color-unread-indicator": "#1f857d",

    "--color-button-secondary-bg": "#edf0f0",
    "--color-button-secondary-hover-bg": "#e2e7e7",
    "--color-button-secondary-foreground": "#1a1f1f",
    "--color-control-hover-bg": "#14282810",
    "--color-control-active-bg": "#1428281c",
    "--color-input-bg": "#ffffff",
    "--color-input-foreground": "#1a1f1f",
    "--color-input-border": "#cdd4d4",
    "--color-input-placeholder": "#8a9494",

    "--color-list-hover-bg": "#f2f5f5",
    "--color-list-active-bg": "#dcefec",
    "--color-list-active-foreground": "#0f2e2b",
    "--color-list-inactive-bg": "#eceff0",
    "--color-list-highlight-foreground": "#1d6f69",

    "--color-badge-bg": "#e3e8e8",
    "--color-badge-foreground": "#3c4545",
    "--color-badge-accent-bg": "#1d6f69",
    "--color-badge-accent-foreground": "#ffffff",
    "--color-kbd-bg": "#f4f6f6",
    "--color-kbd-foreground": "#4b5454",
    "--color-kbd-border": "#d3d9d9",

    "--color-menu-bg": "#ffffff",
    "--color-menu-foreground": "#1a1f1f",
    "--color-menu-border": "#d3d9d9",
    "--color-menu-selection-bg": "#1d6f69",
    "--color-menu-selection-foreground": "#ffffff",
    "--color-menu-separator": "#e3e7e7",
    "--color-palette-bg": "#ffffff",
    "--color-palette-foreground": "#1a1f1f",
    "--color-palette-active-bg": "#e2f1ef",
    "--color-palette-active-foreground": "#0f2e2b",
    "--color-toast-bg": "#1f2525",
    "--color-toast-foreground": "#eef1f1",
    "--color-toast-border": "#1f2525",
    "--color-scrim": "#0e141433",
    "--color-shadow": "#0e14142e",

    "--color-danger": "#b42318",
    "--color-warning": "#a15c07",
    "--color-success": "#1f7a3d",
    "--color-info": "#1e5fa8",

    "--color-scrollbar-thumb": "#0e141429",
    "--color-scrollbar-thumb-hover": "#0e141447",
    "--color-skeleton-bg": "#eceff0",
    "--color-skeleton-highlight": "#f6f8f8",

    "--color-avatar-foreground": "#ffffff",
    "--color-avatar-1": "#a2462f",
    "--color-avatar-2": "#3f5fa8",
    "--color-avatar-3": "#7a4c9a",
    "--color-avatar-4": "#2f7a55",
    "--color-avatar-5": "#8c6410",
    "--color-avatar-6": "#a13e5b",

    "--shadow-popover": "0 0 0 1px #0e14140f, 0 2px 6px #0e141414, 0 10px 28px -6px #0e14142e",
    "--shadow-overlay": "0 0 0 1px #0e141414, 0 4px 12px #0e141414, 0 24px 56px -12px #0e141447",
  },
};
