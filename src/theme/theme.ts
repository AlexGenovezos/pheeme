import { create } from "zustand";
import { builtInThemes, type ThemeDefinition } from "../styles/themes";
import { themeColorToHex, toCanonicalThemeColor } from "../styles/themes/color";
import { makeReadable } from "../styles/themes/contrast";
import type { ThemeToken } from "../styles/themes/schema";
import { buildThemeFromFile, type ThemeFile } from "../styles/themes/themeFile";
import { type ImportedTheme, themeFromSeeds } from "../styles/themes/t3";
import { FOLDER_THEMES_KEY, readCustomThemes, writeCustomThemes } from "./customThemes";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

/** Also read by the boot script in index.html; change both together. */
export const THEME_MODE_KEY = "pheeme.theme-mode";
export const THEME_MODES: readonly ThemeMode[] = ["system", "light", "dark"];

/** The theme used for each kind: a built-in id or an installed custom theme's. */
export const THEME_CHOICE_KEYS: Record<ResolvedTheme, string> = {
  light: "pheeme.theme-light",
  dark: "pheeme.theme-dark",
};
/**
 * Each kind's app background as hex, for the boot script in index.html to paint
 * before any JS module loads (a custom theme's background isn't in the critical style).
 */
export const THEME_BOOT_KEY = "pheeme.theme-boot";

const DARK_QUERY = "(prefers-color-scheme: dark)";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined; // storage disabled; fall back to System every launch
  }
}

/** The stored value under `key` when it is one of `options`, else `fallback`. */
function readOption<T extends string>(
  key: string,
  options: readonly T[],
  fallback: T,
  storage: StorageLike | undefined,
): T {
  try {
    const stored = storage?.getItem(key);
    return options.includes(stored as T) ? (stored as T) : fallback;
  } catch {
    return fallback;
  }
}

export function readThemeMode(storage: StorageLike | undefined = defaultStorage()): ThemeMode {
  return readOption(THEME_MODE_KEY, THEME_MODES, "system", storage);
}

/**
 * How the sidebar looks with Pheeme Light: its own pale grey, a pale ink-blue wash, the deep
 * ink blue of the app icon, or Pheeme Dark's colours. Other themes keep their own sidebar.
 */
export type SidebarStyle = "light" | "tinted" | "ink" | "dark";
export const SIDEBAR_STYLES: readonly SidebarStyle[] = ["light", "tinted", "ink", "dark"];
export const SIDEBAR_STYLE_KEY = "pheeme.sidebar-style";

export function readSidebarStyle(
  storage: StorageLike | undefined = defaultStorage(),
): SidebarStyle {
  return readOption(SIDEBAR_STYLE_KEY, SIDEBAR_STYLES, "light", storage);
}

export function writeThemeMode(
  mode: ThemeMode,
  storage: StorageLike | undefined = defaultStorage(),
) {
  try {
    storage?.setItem(THEME_MODE_KEY, mode);
  } catch {
    // Quota or privacy mode: the choice just won't survive a relaunch.
  }
}

function writeItem(key: string, value: string, storage = defaultStorage()) {
  try {
    storage?.setItem(key, value);
  } catch {
    // Quota or privacy mode: the choice just won't survive a relaunch.
  }
}

export function readThemeChoices(
  storage: StorageLike | undefined = defaultStorage(),
): Record<ResolvedTheme, string> {
  const read = (kind: ResolvedTheme) => {
    try {
      return storage?.getItem(THEME_CHOICE_KEYS[kind]) || builtInThemes[kind].id;
    } catch {
      return builtInThemes[kind].id;
    }
  };
  return { light: read("light"), dark: read("dark") };
}

export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === "system") return prefersDark ? "dark" : "light";
  return mode;
}

export function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
}

/** WKWebView before Safari 15.4 (macOS 10.13 to early 12) can't parse oklch(). */
function supportsOklch(): boolean {
  return globalThis.CSS?.supports?.("color", "oklch(0 0 0)") ?? true;
}

/** Write a theme's tokens onto :root so every `var(--color-…)` picks them up. */
export function applyTheme(
  theme: ThemeDefinition,
  root: HTMLElement = document.documentElement,
  sidebar: SidebarStyle = "light",
) {
  const oklch = supportsOklch();
  for (const [token, value] of Object.entries(theme.tokens)) {
    const hex = !oklch && token.startsWith("--color-");
    root.style.setProperty(token, hex ? themeColorToHex(value) : value);
  }
  root.dataset.theme = theme.kind;
  root.style.colorScheme = theme.kind;
  applySidebarSurface(theme, sidebar, oklch);
}

const SIDEBAR_STYLE_ID = "pheeme-sidebar-surface";

/** Tinted: Pheeme Light's sidebar grey, washed with the accent's ink blue. */
export const TINTED_SIDEBAR_BG = "#e8edf8";
/** Ink: the app icon's engraving ink, a deep blue, with the palette built around it. */
export const INK_SIDEBAR_SEEDS = { background: "#1a2b5c", accent: "#8ba5f2" };

let tintedSidebar: Partial<Record<ThemeToken, string>> | null = null;
/** Tinted: Pheeme Light's colours on the blue wash, with only those that must move (a few mailbox colours) darkened. */
export function tintedSidebarTokens(): Partial<Record<ThemeToken, string>> {
  if (!tintedSidebar) {
    const light = builtInThemes.light.tokens;
    const bg = toCanonicalThemeColor(TINTED_SIDEBAR_BG)!;
    const readable = makeReadable({ ...light, "--color-sidebar-bg": bg });
    tintedSidebar = Object.fromEntries(
      Object.entries(readable).filter(([token, v]) => v !== light[token as ThemeToken]),
    );
  }
  return tintedSidebar;
}

let inkSidebar: ThemeDefinition | null = null;
/** The whole palette the Ink sidebar wears: built from its two colours, readable throughout. */
export function inkSidebarTheme(): ThemeDefinition {
  inkSidebar ??= buildThemeFromFile(themeFromSeeds("Ink sidebar", INK_SIDEBAR_SEEDS));
  return inkSidebar;
}

/**
 * The sidebar's own surface under Pheeme Light, as CSS scoped to `.shell__sidebar`: nothing for
 * the Light style (and for every other theme, which keeps its own sidebar), a new background for
 * Tinted, and a whole dark palette for Ink and Dark, so it stands apart from the light panes.
 */
export function sidebarSurfaceCss(
  theme: ThemeDefinition,
  style: SidebarStyle,
  oklch = true,
): string {
  if (theme.id !== builtInThemes.light.id || style === "light") return "";
  const value = (token: string, v: string) =>
    !oklch && token.startsWith("--color-") ? themeColorToHex(v) : v;
  const surface =
    style === "tinted"
      ? tintedSidebarTokens()
      : style === "ink"
        ? inkSidebarTheme().tokens
        : builtInThemes.dark.tokens;
  const vars = Object.entries(surface)
    .map(([token, v]) => `${token}:${value(token, v)}`)
    .join(";");
  // Solid, not a tint over macOS vibrancy: the material under it is the light one, and would wash out the colour.
  const solid = value("--color-sidebar-bg", surface["--color-sidebar-bg"]!);
  const sidebar = `${vars};--color-sidebar-vibrant-bg:${solid}`;
  return (
    `:root{--color-sidebar-surface:${solid}}` +
    (style === "tinted"
      ? `.shell__sidebar{${sidebar}}`
      : // No pane lines (its edge, above its footer): the dark surface is edge enough.
        `.shell__sidebar{${sidebar};--color-pane-border:transparent;color-scheme:dark;color:var(--color-sidebar-foreground)}`)
  );
}

function applySidebarSurface(theme: ThemeDefinition, sidebar: SidebarStyle, oklch: boolean) {
  if (typeof document === "undefined") return;
  let style = document.getElementById(SIDEBAR_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = SIDEBAR_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = sidebarSurfaceCss(theme, sidebar, oklch);
}

export type ThemeListener = (mode: ThemeMode, theme: ThemeDefinition) => void;

/** Where a theme comes from: shipped with Pheeme, installed by the user, or a file in the themes folder. */
export type ThemeSource = "built-in" | "custom" | "folder";

/** One theme the user can pick. */
export interface ThemeOption {
  id: string;
  name: string;
  kind: ResolvedTheme;
  source: ThemeSource;
}

interface ThemeState {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  /** The chosen theme id for Light and for Dark mode. Any theme can go in either, as in T3 Code. */
  choices: Record<ResolvedTheme, string>;
  /** How the sidebar looks with Pheeme Light. */
  sidebarStyle: SidebarStyle;
  /** Installed custom themes, in install order. */
  customThemes: ThemeFile[];
  /** Themes read from the themes folder at launch (not saved; the files are the source). */
  folderThemes: ThemeFile[];
  setMode(mode: ThemeMode): void;
  /** Flip between Light and Dark, starting from whatever is showing now. */
  toggle(): void;
  /** Use theme `id` whenever Pheeme is in `kind` mode. */
  chooseTheme(kind: ResolvedTheme, id: string): void;
  setSidebarStyle(style: SidebarStyle): void;
  /**
   * Install themes (replacing any with the same id), pick each for the mode it
   * was meant for (a light/dark pair sets both), and show the last one, so the
   * user sees what they imported. Throws when the themes can't be saved.
   */
  installThemes(themes: ImportedTheme[]): void;
  /** Uninstall a custom theme; a mode that used it goes back to the built-in theme. */
  removeTheme(id: string): void;
  /** Replace the themes-folder themes (launch, and whenever the folder is re-read). */
  setFolderThemes(files: ThemeFile[]): void;
}

let listener: ThemeListener | null = null;
/** A theme being edited: shown in place of the chosen one until the editor closes. */
let preview: ThemeDefinition | null = null;

const built = new WeakMap<ThemeFile, ThemeDefinition>();
export function definitionOf(file: ThemeFile): ThemeDefinition {
  let theme = built.get(file);
  if (!theme) {
    theme = buildThemeFromFile(file);
    built.set(file, theme);
  }
  return theme;
}

/** Every theme file available, installed ones winning over a folder file with the same id. */
export function availableThemes(customThemes: ThemeFile[], folderThemes: ThemeFile[] = []) {
  const custom = new Set(customThemes.map((t) => t.id));
  return [...folderThemes.filter((t) => !custom.has(t.id)), ...customThemes];
}

/** The theme shown in `kind` mode: the chosen one when it exists, else the built-in theme for that mode. */
export function themeFor(
  kind: ResolvedTheme,
  choices: Record<ResolvedTheme, string>,
  customThemes: ThemeFile[],
  folderThemes: ThemeFile[] = [],
): ThemeDefinition {
  const id = choices[kind];
  const file = availableThemes(customThemes, folderThemes).find((t) => t.id === id);
  if (file) return definitionOf(file);
  return Object.values(builtInThemes).find((t) => t.id === id) ?? builtInThemes[kind];
}

/** Every theme that can be chosen: the built-in ones first (this mode's on top), then the rest by name. */
export function themeOptions(
  kind: ResolvedTheme,
  customThemes: ThemeFile[],
  folderThemes: ThemeFile[] = [],
): ThemeOption[] {
  const other: ResolvedTheme = kind === "light" ? "dark" : "light";
  const custom = new Set(customThemes.map((t) => t.id));
  const builtIn = [builtInThemes[kind], builtInThemes[other]].map((t) => ({
    id: t.id,
    name: t.name,
    kind: t.kind,
    source: "built-in" as const,
  }));
  const files = availableThemes(customThemes, folderThemes)
    .map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      source: custom.has(t.id) ? ("custom" as const) : ("folder" as const),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...builtIn, ...files];
}

/** The theme file behind an id, or null for a built-in theme. */
export function themeFileById(id: string): ThemeFile | null {
  const { customThemes, folderThemes } = useThemeStore.getState();
  return availableThemes(customThemes, folderThemes).find((t) => t.id === id) ?? null;
}

function commit(mode: ThemeMode) {
  const { choices, customThemes, folderThemes, sidebarStyle } = useThemeStore.getState();
  const resolved = resolveTheme(mode, systemPrefersDark());
  const chosen = themeFor(resolved, choices, customThemes, folderThemes);
  const theme = preview ?? chosen;
  applyTheme(theme, document.documentElement, sidebarStyle);
  useThemeStore.setState({ mode, resolved });
  const appBg = (kind: ResolvedTheme) =>
    themeColorToHex(themeFor(kind, choices, customThemes, folderThemes).tokens["--color-app-bg"]);
  writeItem(THEME_BOOT_KEY, JSON.stringify({ light: appBg("light"), dark: appBg("dark") }));
  listener?.(mode, theme);
}

/**
 * Show `theme` in place of the chosen one (the editor's live preview), or go back
 * to the chosen theme with null. Mode changes keep showing the preview.
 */
export function previewTheme(theme: ThemeDefinition | null) {
  preview = theme;
  commit(useThemeStore.getState().mode);
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  mode: "system",
  resolved: "light",
  choices: { light: builtInThemes.light.id, dark: builtInThemes.dark.id },
  sidebarStyle: "light",
  customThemes: [],
  folderThemes: [],
  setMode(mode) {
    writeThemeMode(mode);
    commit(mode);
  },
  toggle() {
    get().setMode(get().resolved === "dark" ? "light" : "dark");
  },
  chooseTheme(kind, id) {
    writeItem(THEME_CHOICE_KEYS[kind], id);
    set({ choices: { ...get().choices, [kind]: id } });
    commit(get().mode);
  },
  setSidebarStyle(sidebarStyle) {
    writeItem(SIDEBAR_STYLE_KEY, sidebarStyle);
    set({ sidebarStyle });
    commit(get().mode);
  },
  installThemes(themes) {
    if (themes.length === 0) return;
    // Two picked files with the same id: the later one wins, as it would on re-import.
    const byId = new Map(themes.map((t) => [t.file.id, t]));
    themes = [...byId.values()];
    const customThemes = [
      ...get().customThemes.filter((t) => !byId.has(t.id)),
      ...themes.map((t) => t.file),
    ];
    writeCustomThemes(customThemes, defaultStorage());
    const choices = { ...get().choices };
    for (const { file, slot } of themes) {
      choices[slot] = file.id;
      writeItem(THEME_CHOICE_KEYS[slot], file.id);
    }
    set({ customThemes, choices });
    const last = themes[themes.length - 1];
    if (resolveTheme(get().mode, systemPrefersDark()) === last.slot) commit(get().mode);
    else get().setMode(last.slot);
  },
  removeTheme(id) {
    const customThemes = get().customThemes.filter((t) => t.id !== id);
    writeCustomThemes(customThemes, defaultStorage());
    const { folderThemes } = get();
    const choices = { ...get().choices };
    for (const kind of ["light", "dark"] as const) {
      // A folder theme with the same id takes over; otherwise back to the built-in theme.
      if (choices[kind] !== id || folderThemes.some((t) => t.id === id)) continue;
      choices[kind] = builtInThemes[kind].id;
      writeItem(THEME_CHOICE_KEYS[kind], choices[kind]);
    }
    set({ customThemes, choices });
    commit(get().mode);
  },
  setFolderThemes(folderThemes) {
    try {
      writeCustomThemes(folderThemes, defaultStorage(), FOLDER_THEMES_KEY);
    } catch {
      // Only a launch-time cache: the folder is read again next launch.
    }
    set({ folderThemes });
    commit(get().mode);
  },
}));

/**
 * Apply the persisted mode and themes now (before React renders) and follow the OS
 * appearance live while in System mode. Returns a cleanup function.
 */
export function initTheme(onChange?: ThemeListener): () => void {
  listener = onChange ?? null;
  const storage = defaultStorage();
  useThemeStore.setState({
    choices: readThemeChoices(storage),
    sidebarStyle: readSidebarStyle(storage),
    customThemes: readCustomThemes(storage),
    // Last launch's copy, so a chosen folder theme shows before the folder is read again.
    folderThemes: readCustomThemes(storage, FOLDER_THEMES_KEY),
  });
  commit(readThemeMode(storage));

  if (typeof window.matchMedia !== "function") return () => (listener = null);
  const query = window.matchMedia(DARK_QUERY);
  const onSystemChange = () => {
    if (useThemeStore.getState().mode === "system") commit("system");
  };
  query.addEventListener("change", onSystemChange);
  return () => {
    query.removeEventListener("change", onSystemChange);
    listener = null;
  };
}
