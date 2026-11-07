import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { parseThemeFile, type ThemeFile } from "../styles/themes/themeFile";
import { isVsCodeTheme, parseVsCodeTheme } from "../styles/themes/vscode";

/** Installed custom themes, as an array of theme files (themeFile.ts). */
export const CUSTOM_THEMES_KEY = "pheeme.custom-themes";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/**
 * Read a file the user picked: a Pheeme theme file or a VS Code color theme.
 * VS Code themes are JSON with comments and trailing commas, so both are allowed.
 * Throws an Error whose message can be shown as is.
 */
export function parseThemeText(text: string, fileName?: string): ThemeFile {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const [first] = errors;
    throw new Error(
      `${fileName ?? "That file"} isn't valid JSON (${printParseErrorCode(first.error)} at character ${first.offset}).`,
    );
  }
  return isVsCodeTheme(value) ? parseVsCodeTheme(value, fileName) : parseThemeFile(value);
}

/** The installed themes. A stored theme that no longer validates is skipped, not fatal. */
export function readCustomThemes(storage: StorageLike | undefined): ThemeFile[] {
  let raw: string | null | undefined;
  try {
    raw = storage?.getItem(CUSTOM_THEMES_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    console.warn("Custom themes are unreadable; using the built-in themes");
    return [];
  }
  if (!Array.isArray(stored)) return [];
  const themes: ThemeFile[] = [];
  for (const entry of stored) {
    try {
      const file = parseThemeFile(entry);
      if (!themes.some((t) => t.id === file.id)) themes.push(file);
    } catch (err) {
      console.warn("Skipping a stored custom theme", err);
    }
  }
  return themes;
}

/** Save the installed themes. Throws when storage refuses (full, or disabled). */
export function writeCustomThemes(themes: ThemeFile[], storage: StorageLike | undefined) {
  if (!storage) throw new Error("Pheeme can't save themes here: storage is turned off.");
  try {
    storage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(themes));
  } catch {
    throw new Error("Pheeme couldn't save the theme: storage is full or turned off.");
  }
}
