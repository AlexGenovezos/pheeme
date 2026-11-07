import { buildTheme, DERIVED_TOKENS, type ThemeSource } from "./build";
import { contrastRatio, flattenOnto, mixColors, toCanonicalThemeColor, withAlpha } from "./color";
import { makeReadable } from "./contrast";
import { darkSource } from "./dark";
import { lightSource } from "./light";
import { THEME_TOKENS, type ThemeToken } from "./schema";
import {
  MAX_THEME_NAME_LENGTH,
  RESERVED_THEME_IDS,
  THEME_FILE_VERSION,
  type ThemeFile,
  themeFileFromTokens,
  themeIdFromName,
} from "./themeFile";

/**
 * Turn a VS Code color theme (the JSON in a theme extension) into a Pheeme
 * theme file. Each Pheeme color is read from its VS Code key (schema.ts) or a
 * close neighbour; see-through colors are flattened onto the surface they sit
 * on; anything missing is mixed from the theme's own background and text, or
 * (for hues like status and avatar colors) taken from the built-in theme of
 * the same kind. Finally every color is adjusted until text is readable
 * (contrast.ts). Modeled on T3 Code's parseVsCodeThemeFile.
 */

type Kind = ThemeFile["kind"];
type Tokens = Partial<Record<ThemeToken, string>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A VS Code theme rather than a Pheeme theme file: workbench colors (`editor.background`) or syntax colors. */
export function isVsCodeTheme(value: unknown): boolean {
  if (!isRecord(value) || value.version === THEME_FILE_VERSION) return false;
  const workbench =
    isRecord(value.colors) && Object.keys(value.colors).some((k) => k.includes("."));
  return workbench || Array.isArray(value.tokenColors);
}

/** VS Code's own editor background when a theme leaves it out. */
const DEFAULT_CANVAS: Record<string, string> = {
  dark: "#1e1e1e",
  light: "#ffffff",
  "hc-black": "#000000",
  "hc-light": "#ffffff",
};

/** `my-theme_dark` → `My Theme Dark`, `monokai` → `Monokai`; names already written as words stay as they are. */
export function humanizeThemeName(raw: string): string {
  const trimmed = raw.trim();
  if (/\s/.test(trimmed)) return trimmed;
  if (!/[-_.]/.test(trimmed))
    return trimmed === trimmed.toLowerCase()
      ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
      : trimmed;
  return trimmed
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function themeName(value: Record<string, unknown>, fileName?: string): string {
  const stem = fileName?.replace(/\.[^.]+$/, "").replace(/-color-theme$/i, "");
  for (const candidate of [value.displayName, value.name, stem]) {
    if (typeof candidate !== "string") continue;
    const name = humanizeThemeName(candidate).slice(0, MAX_THEME_NAME_LENGTH).trim();
    if (name) return name;
  }
  return "VS Code theme";
}

const standsApart = (a: string, b: string, min = 1.1) => contrastRatio(a, b) >= min;

export function parseVsCodeTheme(value: unknown, fileName?: string): ThemeFile {
  if (!isRecord(value)) throw new Error("A theme file must contain a JSON object.");
  const colors = isRecord(value.colors) ? value.colors : {};
  const type = typeof value.type === "string" ? value.type.toLowerCase() : "";

  /** A VS Code color as canonical OKLCH, or null when missing or not a color. */
  const read = (key: string) =>
    typeof colors[key] === "string" ? toCanonicalThemeColor(colors[key] as string) : null;

  const declared = read("editor.background") ?? read("editorPane.background");
  const fallbackCanvas = DEFAULT_CANVAS[type];
  if (!declared && !fallbackCanvas)
    throw new Error(
      'That VS Code theme has no "editor.background" color, so there is nothing to build a theme from.',
    );
  const canvasBase = fallbackCanvas ?? (type.includes("light") ? "#ffffff" : "#000000");
  const canvas = flattenOnto(declared ?? canvasBase, canvasBase);
  const kind: Kind =
    type === "light" || type === "hc-light"
      ? "light"
      : type === "dark" || type === "hc-black"
        ? "dark"
        : contrastRatio(canvas, "#000000") > contrastRatio(canvas, "#ffffff")
          ? "light"
          : "dark";
  const builtIn = (kind === "light" ? lightSource : darkSource).tokens as Record<
    ThemeToken,
    string
  >;

  const t: Tokens = { "--color-app-bg": canvas };
  const get = (token: ThemeToken) => t[token]!;
  /** The first of `keys` the theme defines, flattened onto `over` (the app background by default). */
  const pick = (keys: string[], over: ThemeToken = "--color-app-bg") => {
    for (const key of keys) {
      const color = read(key);
      if (color) return flattenOnto(color, get(over));
    }
    return null;
  };
  /** Like `pick`, but keeps transparency: for colors Pheeme itself draws see-through. */
  const pickTranslucent = (keys: string[]) => {
    for (const key of keys) {
      const color = read(key);
      if (color) return color;
    }
    return null;
  };
  /** The background with `amount` of the text color mixed in: neutral surfaces and borders. */
  const tint = (amount: number) => mixColors(canvas, get("--color-foreground"), amount);
  const visible = (color: string | null, against: ThemeToken = "--color-app-bg") =>
    color && standsApart(color, get(against)) ? color : null;

  const set = (token: ThemeToken, value: string) => (t[token] = value);

  // Text first: most fallbacks are mixed from it.
  set(
    "--color-foreground",
    pick(["editor.foreground", "foreground"]) ?? builtIn["--color-foreground"],
  );
  set("--color-sidebar-bg", pick(["sideBar.background", "activityBar.background"]) ?? canvas);
  set(
    "--color-sidebar-foreground",
    pick(["sideBar.foreground", "foreground"], "--color-sidebar-bg") ?? get("--color-foreground"),
  );
  set(
    "--color-border",
    visible(pick(["panel.border", "editorGroup.border", "widget.border", "contrastBorder"])) ??
      tint(0.18),
  );
  set("--color-border-subtle", pick(["editorGroup.border", "panel.border"]) ?? tint(0.1));
  set(
    "--color-pane-border",
    pick(["sideBar.border", "panel.border", "editorGroup.border"]) ?? get("--color-border-subtle"),
  );
  set("--color-foreground-muted", pick(["descriptionForeground"]) ?? tint(0.7));
  set("--color-foreground-subtle", get("--color-foreground-muted"));
  set("--color-foreground-disabled", pick(["disabledForeground"]) ?? tint(0.45));

  // The accent: the first brand color that stands out from the background.
  let accent: string | null = null;
  for (const key of [
    "button.background",
    "focusBorder",
    "textLink.foreground",
    "activityBarBadge.background",
    "progressBar.background",
    "badge.background",
  ]) {
    accent = visible(pick([key]));
    if (accent) break;
  }
  set("--color-accent", accent ?? builtIn["--color-accent"]);
  set(
    "--color-accent-foreground",
    pick(["button.foreground"], "--color-accent") ?? builtIn["--color-accent-foreground"],
  );
  set(
    "--color-link",
    visible(pick(["textLink.foreground", "textLink.activeForeground"])) ?? get("--color-accent"),
  );
  set(
    "--color-selection-bg",
    pick(["editor.selectionBackground", "selection.background"]) ??
      mixColors(canvas, get("--color-accent"), 0.25),
  );
  set("--color-focus-border", visible(pick(["focusBorder"])) ?? get("--color-accent"));
  set(
    "--color-unread-indicator",
    visible(pick(["activityBarBadge.background"])) ?? get("--color-accent"),
  );

  // Controls
  set("--color-button-secondary-bg", pick(["button.secondaryBackground"]) ?? tint(0.08));
  set(
    "--color-control-hover-bg",
    pickTranslucent(["toolbar.hoverBackground"]) ?? withAlpha(get("--color-foreground"), 0.08),
  );
  set("--color-input-bg", pick(["input.background"]) ?? canvas);
  set("--color-input-border", pick(["input.border"], "--color-input-bg") ?? get("--color-border"));
  set(
    "--color-input-placeholder",
    pick(["input.placeholderForeground"], "--color-input-bg") ?? get("--color-foreground-muted"),
  );

  // Lists
  set("--color-list-hover-bg", pick(["list.hoverBackground"]) ?? tint(0.05));
  set(
    "--color-list-active-bg",
    pick(["list.activeSelectionBackground"]) ?? mixColors(canvas, get("--color-accent"), 0.16),
  );
  set(
    "--color-list-active-foreground",
    pick(["list.activeSelectionForeground"], "--color-list-active-bg") ?? get("--color-foreground"),
  );
  set("--color-list-inactive-bg", pick(["list.inactiveSelectionBackground"]) ?? tint(0.08));

  // Badges and keybinding labels
  set("--color-badge-bg", pick(["badge.background"]) ?? tint(0.1));
  set(
    "--color-badge-foreground",
    pick(["badge.foreground"], "--color-badge-bg") ?? get("--color-foreground"),
  );
  set("--color-kbd-bg", pick(["keybindingLabel.background"]) ?? tint(0.05));
  set(
    "--color-kbd-foreground",
    pick(["keybindingLabel.foreground"], "--color-kbd-bg") ?? get("--color-foreground"),
  );
  set(
    "--color-kbd-border",
    pick(["keybindingLabel.border", "keybindingLabel.bottomBorder"], "--color-kbd-bg") ??
      get("--color-border"),
  );

  // Floating surfaces
  set(
    "--color-menu-bg",
    pick(["menu.background", "editorWidget.background", "dropdown.background"]) ?? canvas,
  );
  set(
    "--color-menu-selection-bg",
    pick(["menu.selectionBackground", "list.activeSelectionBackground"], "--color-menu-bg") ??
      get("--color-accent"),
  );
  set(
    "--color-menu-selection-foreground",
    pick(
      ["menu.selectionForeground", "list.activeSelectionForeground"],
      "--color-menu-selection-bg",
    ) ?? get("--color-accent-foreground"),
  );
  set(
    "--color-menu-separator",
    pick(["menu.separatorBackground"], "--color-menu-bg") ?? get("--color-border-subtle"),
  );
  set(
    "--color-palette-bg",
    pick(["quickInput.background", "editorWidget.background"]) ?? get("--color-menu-bg"),
  );
  set(
    "--color-palette-active-bg",
    pick(
      ["quickInputList.focusBackground", "list.activeSelectionBackground"],
      "--color-palette-bg",
    ) ?? get("--color-list-active-bg"),
  );
  set(
    "--color-toast-bg",
    pick(["notifications.background", "editorWidget.background"]) ?? get("--color-menu-bg"),
  );
  set(
    "--color-toast-foreground",
    pick(["notifications.foreground", "foreground"], "--color-toast-bg") ??
      get("--color-foreground"),
  );
  set(
    "--color-toast-border",
    pick(["notifications.border", "editorWidget.border"], "--color-toast-bg") ??
      get("--color-border"),
  );
  set("--color-scrim", builtIn["--color-scrim"]);
  set("--color-shadow", pickTranslucent(["widget.shadow"]) ?? builtIn["--color-shadow"]);

  // Status: the theme's hue when it has one that shows; readability comes later.
  const status = (token: ThemeToken, keys: string[]) =>
    set(token, visible(pick(keys)) ?? builtIn[token]);
  status("--color-danger", ["errorForeground", "editorError.foreground"]);
  status("--color-warning", ["editorWarning.foreground", "list.warningForeground"]);
  status("--color-success", [
    "testing.iconPassed",
    "gitDecoration.addedResourceForeground",
    "terminal.ansiGreen",
  ]);
  status("--color-info", [
    "editorInfo.foreground",
    "notificationsInfoIcon.foreground",
    "terminal.ansiBlue",
  ]);

  // Scrollbars and loading
  set(
    "--color-scrollbar-thumb",
    pickTranslucent(["scrollbarSlider.background"]) ?? builtIn["--color-scrollbar-thumb"],
  );
  set("--color-skeleton-bg", tint(0.07));
  set("--color-skeleton-highlight", tint(0.03));

  // Hues with a VS Code chart or terminal color (schema.ts); otherwise the built-in theme's.
  set("--color-avatar-foreground", builtIn["--color-avatar-foreground"]);
  for (const token of Object.keys(THEME_TOKENS) as ThemeToken[]) {
    if (!/^--color-(avatar-\d|account-\d|mailbox-)/.test(token)) continue;
    const key = THEME_TOKENS[token];
    set(token, (key && pick([key], "--color-sidebar-bg")) ?? builtIn[token]);
  }

  // Shadows aren't colors: the built-in theme's elevation fits any background of its kind.
  set("--shadow-popover", builtIn["--shadow-popover"]);
  set("--shadow-overlay", builtIn["--shadow-overlay"]);

  const derived = new Set<string>(DERIVED_TOKENS);
  const missing = (Object.keys(THEME_TOKENS) as ThemeToken[]).filter(
    (token) => !derived.has(token) && t[token] === undefined,
  );
  if (missing.length) throw new Error(`VS Code import has no rule for ${missing.join(", ")}`);

  const name = themeName(value, fileName);
  const generated = themeIdFromName(name);
  const id = RESERVED_THEME_IDS.has(generated) ? `${generated}-vscode` : generated;
  const theme = buildTheme({ id, name, kind, tokens: t as ThemeSource["tokens"] });
  return themeFileFromTokens({ id, name, kind }, makeReadable(theme.tokens));
}
