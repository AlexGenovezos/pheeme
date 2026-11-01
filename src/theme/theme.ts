import { create } from "zustand";
import { builtInThemes, type ThemeDefinition } from "../styles/themes";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

/** Also read by the boot script in index.html; change both together. */
export const THEME_MODE_KEY = "pheeme.theme-mode";
export const THEME_MODES: readonly ThemeMode[] = ["system", "light", "dark"];

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

export function writeThemeMode(mode: ThemeMode, storage: StorageLike | undefined = defaultStorage()) {
  try {
    storage?.setItem(THEME_MODE_KEY, mode);
  } catch {
    // Quota or privacy mode: the choice just won't survive a relaunch.
  }
}

export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === "system") return prefersDark ? "dark" : "light";
  return mode;
}

export function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
}

/** Write a theme's tokens onto :root so every `var(--color-…)` picks them up. */
export function applyTheme(theme: ThemeDefinition, root: HTMLElement = document.documentElement) {
  for (const [token, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(token, value);
  }
  root.dataset.theme = theme.kind;
  root.style.colorScheme = theme.kind;
}

export type ThemeListener = (mode: ThemeMode, theme: ThemeDefinition) => void;

interface ThemeState {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode(mode: ThemeMode): void;
  /** Flip between Light and Dark, starting from whatever is showing now. */
  toggle(): void;
}

let listener: ThemeListener | null = null;

function commit(mode: ThemeMode) {
  const resolved = resolveTheme(mode, systemPrefersDark());
  const theme = builtInThemes[resolved];
  applyTheme(theme);
  useThemeStore.setState({ mode, resolved });
  listener?.(mode, theme);
}

export const useThemeStore = create<ThemeState>((_set, get) => ({
  mode: "system",
  resolved: "light",
  setMode(mode) {
    writeThemeMode(mode);
    commit(mode);
  },
  toggle() {
    get().setMode(get().resolved === "dark" ? "light" : "dark");
  },
}));

/**
 * Apply the persisted mode now (before React renders) and follow the OS
 * appearance live while in System mode. Returns a cleanup function.
 */
export function initTheme(onChange?: ThemeListener): () => void {
  listener = onChange ?? null;
  commit(readThemeMode());

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
