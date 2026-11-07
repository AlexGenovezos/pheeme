import { create } from "zustand";
import { builtInThemes, type ThemeDefinition } from "../styles/themes";
import { themeColorToHex } from "../styles/themes/color";
import { buildThemeFromFile, type ThemeFile } from "../styles/themes/themeFile";
import { readCustomThemes, writeCustomThemes } from "./customThemes";

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

export function readThemeMode(storage: StorageLike | undefined = defaultStorage()): ThemeMode {
  const stored = storage?.getItem(THEME_MODE_KEY);
  return THEME_MODES.includes(stored as ThemeMode) ? (stored as ThemeMode) : "system";
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
export function applyTheme(theme: ThemeDefinition, root: HTMLElement = document.documentElement) {
  const oklch = supportsOklch();
  for (const [token, value] of Object.entries(theme.tokens)) {
    const hex = !oklch && token.startsWith("--color-");
    root.style.setProperty(token, hex ? themeColorToHex(value) : value);
  }
  root.dataset.theme = theme.kind;
  root.style.colorScheme = theme.kind;
}

export type ThemeListener = (mode: ThemeMode, theme: ThemeDefinition) => void;

/** One theme the user can pick for a kind. */
export interface ThemeOption {
  id: string;
  name: string;
  custom: boolean;
}

interface ThemeState {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  /** The chosen theme id for each kind. */
  choices: Record<ResolvedTheme, string>;
  /** Installed custom themes, in install order. */
  customThemes: ThemeFile[];
  setMode(mode: ThemeMode): void;
  /** Flip between Light and Dark, starting from whatever is showing now. */
  toggle(): void;
  /** Use theme `id` whenever Pheeme is in `kind` mode. */
  chooseTheme(kind: ResolvedTheme, id: string): void;
  /**
   * Install themes (replacing any with the same id), pick the last one of each
   * kind (a light/dark pair sets both), and show the last one, so the user sees
   * what they imported. Throws when the themes can't be saved.
   */
  installThemes(files: ThemeFile[]): void;
  /** Uninstall a custom theme; a kind that used it goes back to the built-in theme. */
  removeTheme(id: string): void;
}

let listener: ThemeListener | null = null;

const built = new WeakMap<ThemeFile, ThemeDefinition>();
function definitionOf(file: ThemeFile): ThemeDefinition {
  let theme = built.get(file);
  if (!theme) {
    theme = buildThemeFromFile(file);
    built.set(file, theme);
  }
  return theme;
}

/** The theme shown for `kind`: the chosen custom theme when it is installed, else the built-in one. */
export function themeFor(
  kind: ResolvedTheme,
  choices: Record<ResolvedTheme, string>,
  customThemes: ThemeFile[],
): ThemeDefinition {
  const file = customThemes.find((t) => t.id === choices[kind] && t.kind === kind);
  return file ? definitionOf(file) : builtInThemes[kind];
}

/** Every theme that can be chosen for `kind`, the built-in one first. */
export function themeOptions(kind: ResolvedTheme, customThemes: ThemeFile[]): ThemeOption[] {
  const builtIn = builtInThemes[kind];
  return [
    { id: builtIn.id, name: builtIn.name, custom: false },
    ...customThemes
      .filter((t) => t.kind === kind)
      .map((t) => ({ id: t.id, name: t.name, custom: true })),
  ];
}

function commit(mode: ThemeMode) {
  const { choices, customThemes } = useThemeStore.getState();
  const resolved = resolveTheme(mode, systemPrefersDark());
  const theme = themeFor(resolved, choices, customThemes);
  applyTheme(theme);
  useThemeStore.setState({ mode, resolved });
  const appBg = (kind: ResolvedTheme) =>
    themeColorToHex(themeFor(kind, choices, customThemes).tokens["--color-app-bg"]);
  writeItem(THEME_BOOT_KEY, JSON.stringify({ light: appBg("light"), dark: appBg("dark") }));
  listener?.(mode, theme);
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  mode: "system",
  resolved: "light",
  choices: { light: builtInThemes.light.id, dark: builtInThemes.dark.id },
  customThemes: [],
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
  installThemes(files) {
    if (files.length === 0) return;
    const ids = new Set(files.map((f) => f.id));
    const customThemes = [...get().customThemes.filter((t) => !ids.has(t.id)), ...files];
    writeCustomThemes(customThemes, defaultStorage());
    const choices = { ...get().choices };
    for (const file of files) {
      choices[file.kind] = file.id;
      writeItem(THEME_CHOICE_KEYS[file.kind], file.id);
    }
    set({ customThemes, choices });
    const last = files[files.length - 1];
    if (resolveTheme(get().mode, systemPrefersDark()) === last.kind) commit(get().mode);
    else get().setMode(last.kind);
  },
  removeTheme(id) {
    const customThemes = get().customThemes.filter((t) => t.id !== id);
    writeCustomThemes(customThemes, defaultStorage());
    const choices = { ...get().choices };
    for (const kind of ["light", "dark"] as const) {
      if (choices[kind] !== id) continue;
      choices[kind] = builtInThemes[kind].id;
      writeItem(THEME_CHOICE_KEYS[kind], choices[kind]);
    }
    set({ customThemes, choices });
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
    customThemes: readCustomThemes(storage),
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
