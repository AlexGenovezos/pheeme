/**
 * The theme contract: every token a theme must define, and the VS Code
 * color-theme key each one is meant to be filled from when custom themes can be
 * imported from VS Code JSON (design doc §6, post-v1). `null` means VS Code has
 * no matching key; an importer derives those from neighbours or keeps ours.
 *
 * Token                                VS Code key
 * ------------------------------------ ----------------------------------------
 */
export const THEME_TOKENS = {
  // Surfaces
  "--color-app-bg": "editor.background",
  "--color-pane-bg": "editor.background",
  "--color-sidebar-bg": "sideBar.background",
  // macOS: a tint over the window's sidebar vibrancy instead of the solid fill.
  "--color-sidebar-vibrant-bg": null,
  "--color-sidebar-foreground": "sideBar.foreground",
  "--color-titlebar-bg": "titleBar.activeBackground",
  "--color-pane-border": "sideBar.border",
  "--color-border": "contrastBorder",
  "--color-border-subtle": "editorGroup.border",

  // Text
  "--color-foreground": "foreground",
  "--color-foreground-muted": "descriptionForeground",
  "--color-foreground-subtle": "descriptionForeground",
  "--color-foreground-disabled": "disabledForeground",
  "--color-link": "textLink.foreground",
  "--color-selection-bg": "editor.selectionBackground",

  // Accent and focus
  "--color-accent": "button.background",
  "--color-accent-hover": "button.hoverBackground",
  "--color-accent-foreground": "button.foreground",
  "--color-focus-border": "focusBorder",
  "--color-unread-indicator": "activityBarBadge.background",

  // Controls
  "--color-button-secondary-bg": "button.secondaryBackground",
  "--color-button-secondary-hover-bg": "button.secondaryHoverBackground",
  "--color-button-secondary-foreground": "button.secondaryForeground",
  "--color-control-hover-bg": "toolbar.hoverBackground",
  "--color-control-active-bg": "toolbar.activeBackground",
  "--color-input-bg": "input.background",
  "--color-input-foreground": "input.foreground",
  "--color-input-border": "input.border",
  "--color-input-placeholder": "input.placeholderForeground",

  // Lists
  "--color-list-hover-bg": "list.hoverBackground",
  "--color-list-active-bg": "list.activeSelectionBackground",
  "--color-list-active-foreground": "list.activeSelectionForeground",
  "--color-list-inactive-bg": "list.inactiveSelectionBackground",
  "--color-list-highlight-foreground": "list.highlightForeground",

  // Badges and keybinding labels
  "--color-badge-bg": "badge.background",
  "--color-badge-foreground": "badge.foreground",
  "--color-badge-accent-bg": "activityBarBadge.background",
  "--color-badge-accent-foreground": "activityBarBadge.foreground",
  "--color-kbd-bg": "keybindingLabel.background",
  "--color-kbd-foreground": "keybindingLabel.foreground",
  "--color-kbd-border": "keybindingLabel.border",

  // Floating surfaces
  "--color-menu-bg": "menu.background",
  "--color-menu-foreground": "menu.foreground",
  "--color-menu-border": "menu.border",
  "--color-menu-selection-bg": "menu.selectionBackground",
  "--color-menu-selection-foreground": "menu.selectionForeground",
  "--color-menu-separator": "menu.separatorBackground",
  "--color-palette-bg": "quickInput.background",
  "--color-palette-foreground": "quickInput.foreground",
  "--color-palette-active-bg": "quickInputList.focusBackground",
  "--color-palette-active-foreground": "quickInputList.focusForeground",
  "--color-toast-bg": "notifications.background",
  "--color-toast-foreground": "notifications.foreground",
  "--color-toast-border": "notifications.border",
  "--color-scrim": null,
  "--color-shadow": "widget.shadow",

  // Status
  "--color-danger": "errorForeground",
  "--color-warning": "editorWarning.foreground",
  "--color-success": "testing.iconPassed",
  "--color-info": "editorInfo.foreground",

  // Scrollbars and loading
  "--color-scrollbar-thumb": "scrollbarSlider.background",
  "--color-scrollbar-thumb-hover": "scrollbarSlider.hoverBackground",
  "--color-skeleton-bg": null,
  "--color-skeleton-highlight": null,

  // Avatars (initials fallback). VS Code's chart palette is the closest match.
  "--color-avatar-foreground": null,
  "--color-avatar-1": "charts.red",
  "--color-avatar-2": "charts.blue",
  "--color-avatar-3": "charts.purple",
  "--color-avatar-4": "charts.green",
  "--color-avatar-5": "charts.yellow",
  "--color-avatar-6": "charts.orange",

  // Accounts: the dot beside each account in the sidebar and in All Inboxes.
  "--color-account-1": "charts.blue",
  "--color-account-2": "charts.green",
  "--color-account-3": "charts.orange",
  "--color-account-4": "charts.purple",
  "--color-account-5": "charts.red",
  "--color-account-6": "charts.yellow",

  // Sidebar mailbox rows: icon color, and the tint and label color when selected.
  // Used as text on the selected row, so each needs 4.5:1 on the tinted sidebar.
  "--color-mailbox-primary": "charts.blue",
  "--color-mailbox-social": "terminal.ansiCyan",
  "--color-mailbox-promotions": "charts.green",
  "--color-mailbox-updates": "charts.orange",
  "--color-mailbox-forums": "charts.purple",
  "--color-mailbox-starred": "charts.yellow",
  "--color-mailbox-drafts": "terminal.ansiBrightBlue",
  "--color-mailbox-sent": "terminal.ansiBrightGreen",
  "--color-mailbox-allmail": "terminal.ansiBrightMagenta",
  "--color-mailbox-spam": "terminal.ansiBrightRed",
  "--color-mailbox-trash": "terminal.ansiRed",

  // Elevation (full box-shadow values; built from --color-shadow-like colors)
  "--shadow-popover": null,
  "--shadow-overlay": null,
} as const satisfies Record<`--${string}`, string | null>;

export type ThemeToken = keyof typeof THEME_TOKENS;

export const AVATAR_COLOR_COUNT = 6;

export interface ThemeDefinition {
  id: string;
  name: string;
  kind: "light" | "dark";
  tokens: Record<ThemeToken, string>;
}
