import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { type ImportedTheme, isT3Theme, parseT3Theme } from "../styles/themes/t3";
import { parseThemeFile, type ThemeFile } from "../styles/themes/themeFile";
import { isVsCodeTheme, parseVsCodeTheme } from "../styles/themes/vscode";

/** Installed custom themes, as an array of theme files (themeFile.ts). */
export const CUSTOM_THEMES_KEY = "pheeme.custom-themes";
/** The themes folder's themes as last read, so they show at launch before the folder is read again. */
export const FOLDER_THEMES_KEY = "pheeme.folder-themes";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/**
 * Read a theme file: a Pheeme theme file, a VS Code color theme or a T3 Code theme
 * (which can hold both a light and a dark half, so a file can give two themes).
 * VS Code themes are JSON with comments and trailing commas, so both are allowed.
 * Throws an Error whose message can be shown as is.
 */
export function parseThemeText(text: string, fileName?: string): ImportedTheme[] {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const [first] = errors;
    throw new Error(
      `${fileName ?? "That file"} isn't valid JSON (${printParseErrorCode(first.error)} at character ${first.offset}).`,
    );
  }
  if (isT3Theme(value)) return parseT3Theme(value, fileName);
  const file = isVsCodeTheme(value) ? parseVsCodeTheme(value, fileName) : parseThemeFile(value);
  return [{ file, slot: file.kind }];
}

/** The installed themes. A stored theme that no longer validates is skipped, not fatal. */
export function readCustomThemes(
  storage: StorageLike | undefined,
  key = CUSTOM_THEMES_KEY,
): ThemeFile[] {
  let raw: string | null | undefined;
  try {
    raw = storage?.getItem(key);
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
export function writeCustomThemes(
  themes: ThemeFile[],
  storage: StorageLike | undefined,
  key = CUSTOM_THEMES_KEY,
) {
  if (!storage) throw new Error("Pheeme can't save themes here: storage is turned off.");
  try {
    storage.setItem(key, JSON.stringify(themes));
  } catch {
    throw new Error("Pheeme couldn't save the theme: storage is full or turned off.");
  }
}
