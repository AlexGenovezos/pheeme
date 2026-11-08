import { buildTheme, type ThemeSource } from "./build";

/**
 * Pheeme Light. Cool mineral greys with one accent, ink blue: the engraving
 * ink of the app icon. The accent is spent on selection, focus, primary
 * actions and unread state only, so it always means "this one".
 *
 * Keep --color-app-bg in sync with the critical style in index.html
 * (theme.test.ts checks it).
 */
export const lightSource: ThemeSource = {
  id: "pheeme-light",
  name: "Pheeme Light",
  kind: "light",
  tokens: {
    "--color-app-bg": "#ffffff",
    "--color-sidebar-bg": "#f2f4f4",
    "--color-sidebar-foreground": "#2e3535",
    "--color-pane-border": "#e2e6e6",
    "--color-border": "#d3d9d9",
    "--color-border-subtle": "#e9ecec",

    "--color-foreground": "#1a1f1f",
    "--color-foreground-muted": "#586262",
    "--color-foreground-subtle": "#596565",
    "--color-foreground-disabled": "#8a9494",
    "--color-link": "#1f45a8",
    "--color-selection-bg": "#c8d5f4",

    "--color-accent": "#1b3f9a",
    "--color-accent-foreground": "#ffffff",
    "--color-focus-border": "#3a63c8",
    "--color-unread-indicator": "#2a55c4",

    "--color-button-secondary-bg": "#edf0f0",
    "--color-control-hover-bg": "#14282810",
    "--color-input-bg": "#ffffff",
    "--color-input-border": "#cdd4d4",
    "--color-input-placeholder": "#596565",

    "--color-list-hover-bg": "#f2f5f5",
    "--color-list-active-bg": "#e0e7f8",
    "--color-list-active-foreground": "#101d42",
    "--color-list-inactive-bg": "#eceff0",

    "--color-badge-bg": "#e3e8e8",
    "--color-badge-foreground": "#3c4545",
    "--color-kbd-bg": "#f4f6f6",
    "--color-kbd-foreground": "#4b5454",
    "--color-kbd-border": "#d3d9d9",

    "--color-menu-bg": "#ffffff",
    "--color-menu-selection-bg": "#1b3f9a",
    "--color-menu-selection-foreground": "#ffffff",
    "--color-menu-separator": "#e3e7e7",
    "--color-palette-bg": "#ffffff",
    "--color-palette-active-bg": "#e6ecfa",
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
    "--color-skeleton-bg": "#eceff0",
    "--color-skeleton-highlight": "#f6f8f8",

    "--color-avatar-foreground": "#ffffff",
    "--color-avatar-1": "#a2462f",
    "--color-avatar-2": "#3f5fa8",
    "--color-avatar-3": "#7a4c9a",
    "--color-avatar-4": "#2f7a55",
    "--color-avatar-5": "#8c6410",
    "--color-avatar-6": "#a13e5b",

    "--color-account-1": "#2f6fd0",
    "--color-account-2": "#2f8a4f",
    "--color-account-3": "#c26a1a",
    "--color-account-4": "#8050c8",
    "--color-account-5": "#c8403a",
    "--color-account-6": "#9a7a08",

    "--color-mailbox-primary": "#1a5bbf",
    "--color-mailbox-social": "#076a77",
    "--color-mailbox-promotions": "#1f7038",
    "--color-mailbox-updates": "#a24a06",
    "--color-mailbox-forums": "#6f3db5",
    "--color-mailbox-starred": "#7d5c00",
    "--color-mailbox-drafts": "#15659b",
    "--color-mailbox-sent": "#237046",
    "--color-mailbox-allmail": "#a32f74",
    "--color-mailbox-spam": "#b23a0a",
    "--color-mailbox-trash": "#b42a26",

    "--shadow-popover": "0 0 0 1px #0e14140f, 0 2px 6px #0e141414, 0 10px 28px -6px #0e14142e",
    "--shadow-overlay": "0 0 0 1px #0e141414, 0 4px 12px #0e141414, 0 24px 56px -12px #0e141447",
  },
};

export const lightTheme = buildTheme(lightSource);
