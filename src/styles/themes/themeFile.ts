import { buildTheme, DERIVED_TOKENS, type ThemeSource } from "./build";
import { toCanonicalThemeColor } from "./color";
import { darkSource } from "./dark";
import { lightSource } from "./light";
import { THEME_TOKENS, type ThemeDefinition, type ThemeToken } from "./schema";

/**
 * Custom theme files: the JSON a user installs. Colors are keyed by token name
 * without the `--color-` prefix (`"app-bg"`, `"accent"`), and any color left
 * out comes from the built-in theme of the same kind, with hover and other
 * derived colors worked out from the file's own base colors (build.ts).
 * Modeled on T3 Code's parseThemeFile / serializeThemeFile.
 *
 * {
 *   "version": 1,
 *   "name": "Harbour",
 *   "kind": "dark",
 *   "colors": { "app-bg": "#10161c", "accent": "#5fb3d9" }
 * }
 */
export const THEME_FILE_VERSION = 1;

export interface ThemeFile {
  version: typeof THEME_FILE_VERSION;
  id: string;
  name: string;
  kind: "light" | "dark";
  /** Canonical OKLCH, keyed by short token name. */
  colors: Record<string, string>;
}

/** Ids a custom theme may not take: the modes, and the built-in themes they resolve to. */
export const RESERVED_THEME_IDS: ReadonlySet<string> = new Set([
  "system",
  "light",
  "dark",
  "pheeme-light",
  "pheeme-dark",
]);

export const MAX_THEME_NAME_LENGTH = 48;

const PREFIX = "--color-";

/** Short file key for a color token: `--color-app-bg` → `app-bg`. */
export const colorKey = (token: ThemeToken) => token.slice(PREFIX.length);

/** Every color token by its short key. Shadows aren't colors and always come from the built-in theme. */
const TOKEN_BY_KEY = new Map(
  (Object.keys(THEME_TOKENS) as ThemeToken[])
    .filter((token) => token.startsWith(PREFIX))
    .map((token) => [colorKey(token), token]),
);

const BUILT_IN_SOURCES: Record<ThemeFile["kind"], ThemeSource> = {
  light: lightSource,
  dark: darkSource,
};

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function themeIdFromName(name: string): string {
  const id = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_THEME_NAME_LENGTH)
    .replace(/-+$/, "");
  return id || "custom-theme";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Validate a parsed theme file and return it in canonical form (id filled in,
 * colors as OKLCH). Throws an Error whose message can be shown as is.
 * Unknown color names are ignored, so a file written for a newer Pheeme still loads.
 */
export function parseThemeFile(value: unknown): ThemeFile {
  if (!isRecord(value)) throw new Error("A theme file must contain a JSON object.");
  if (value.version !== THEME_FILE_VERSION)
    throw new Error(`This theme file's version isn't supported (expected ${THEME_FILE_VERSION}).`);

  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name || name.length > MAX_THEME_NAME_LENGTH)
    throw new Error(`A theme needs a name of ${MAX_THEME_NAME_LENGTH} characters or fewer.`);
  if (value.kind !== "light" && value.kind !== "dark")
    throw new Error('A theme needs a "kind" of "light" or "dark".');

  const id = value.id === undefined ? themeIdFromName(name) : value.id;
  if (typeof id !== "string" || !ID_PATTERN.test(id) || id.length > MAX_THEME_NAME_LENGTH)
    throw new Error("A theme id may only use lowercase letters, numbers and hyphens.");
  if (RESERVED_THEME_IDS.has(id)) throw new Error(`The theme id "${id}" is reserved.`);

  if (!isRecord(value.colors)) throw new Error('A theme needs a "colors" object.');
  const colors: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value.colors)) {
    if (!TOKEN_BY_KEY.has(key)) continue;
    const color = typeof raw === "string" ? toCanonicalThemeColor(raw) : null;
    if (!color) throw new Error(`"${key}" is not a color: ${JSON.stringify(raw)}.`);
    colors[key] = color;
  }
  if (Object.keys(colors).length === 0)
    throw new Error('A theme needs at least one color Pheeme knows, such as "app-bg".');

  return { version: THEME_FILE_VERSION, id, name, kind: value.kind, colors };
}

export function serializeThemeFile(file: ThemeFile): string {
  const { version, id, name, kind, colors } = file;
  return `${JSON.stringify({ version, id, name, kind, colors }, null, 2)}\n`;
}

/** The full theme a file describes, ready to apply. */
export function buildThemeFromFile(file: ThemeFile): ThemeDefinition {
  const base = { ...BUILT_IN_SOURCES[file.kind].tokens } as Record<string, string>;
  // Derived colors follow the file's base colors, not the built-in theme's.
  for (const token of DERIVED_TOKENS) delete base[token];
  for (const [key, color] of Object.entries(file.colors)) base[TOKEN_BY_KEY.get(key)!] = color;
  return buildTheme({
    id: file.id,
    name: file.name,
    kind: file.kind,
    tokens: base as ThemeSource["tokens"],
  });
}

/** A theme file holding every color of a finished theme (what an import produces). */
export function themeFileFromTokens(
  meta: Pick<ThemeFile, "id" | "name" | "kind">,
  tokens: Record<ThemeToken, string>,
): ThemeFile {
  const colors: Record<string, string> = {};
  for (const [key, token] of TOKEN_BY_KEY) colors[key] = tokens[token];
  return parseThemeFile({ version: THEME_FILE_VERSION, ...meta, colors });
}
