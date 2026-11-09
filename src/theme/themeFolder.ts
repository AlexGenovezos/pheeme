import { create } from "zustand";
import { listThemeFolder, type ThemeFolderFile } from "../lib/tauri";
import type { ThemeFile } from "../styles/themes/themeFile";
import { parseThemeText } from "./customThemes";
import { useThemeStore } from "./theme";

/**
 * The themes folder (`{app data}/themes`), T3 Code's `~/.t3/userdata/themes` for
 * Pheeme: drop Pheeme, VS Code or T3 Code theme files in and they can be chosen
 * in Settings › Appearance. Read at launch and whenever the window regains focus,
 * so a file copied in shows up without a restart.
 */
interface ThemeFolderState {
  /** Where the folder is, once read (null before that). */
  path: string | null;
  /** Files that didn't load, with why. */
  failures: string[];
}

export const useThemeFolderStore = create<ThemeFolderState>(() => ({ path: null, failures: [] }));

/** Every theme in the folder's files (a T3 Code file with both halves gives two), and what failed. */
export function parseFolderFiles(files: ThemeFolderFile[]): {
  themes: ThemeFile[];
  failures: string[];
} {
  const themes = new Map<string, ThemeFile>();
  const failures: string[] = [];
  for (const { name, text } of files) {
    try {
      for (const { file } of parseThemeText(text, name)) themes.set(file.id, file);
    } catch (err) {
      failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { themes: [...themes.values()], failures };
}

const sameThemes = (a: ThemeFile[], b: ThemeFile[]) => JSON.stringify(a) === JSON.stringify(b);

export async function loadThemeFolder() {
  try {
    const { path, files } = await listThemeFolder();
    const { themes, failures } = parseFolderFiles(files);
    useThemeFolderStore.setState({ path, failures });
    // Unchanged on most focus events: skip repainting the app for nothing.
    if (!sameThemes(themes, useThemeStore.getState().folderThemes))
      useThemeStore.getState().setFolderThemes(themes);
  } catch (err) {
    console.warn("Couldn't read the themes folder", err);
  }
}

/** Read the folder now and again on every window focus. Returns a cleanup function. */
export function watchThemeFolder(): () => void {
  void loadThemeFolder();
  const onFocus = () => void loadThemeFolder();
  window.addEventListener("focus", onFocus);
  return () => window.removeEventListener("focus", onFocus);
}
