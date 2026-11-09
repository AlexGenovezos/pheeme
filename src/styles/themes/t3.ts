import { toCanonicalThemeColor } from "./color";
import { THEME_FILE_VERSION, type ThemeFile, type ThemeSeeds } from "./themeFile";
import { createVividThemeColors, isDarkColor } from "./vivid";
import { parseVsCodeTheme } from "./vscode";

/**
 * T3 Code theme files (`~/.t3/userdata/themes/*.json`, or exported from T3's
 * theme editor) and the two-color themes Pheeme's own editor builds.
 *
 * {
 *   "version": 1,
 *   "name": "Nocturnal",
 *   "appearance": "dark",
 *   "canvas": "#121314", "accent": "#2b91af",   // optional: the two colors it started from
 *   "colors": { "canvas": "#121314", "text": "#bfbfbf", … },
 *   "variants": { "light": { … } }               // optional: the other half
 * }
 *
 * T3's roles are mapped onto VS Code workbench keys and run through the VS Code
 * importer, which already fills the gaps and makes every text color readable.
 */

type Half = "light" | "dark";

/** A theme from a file, and the mode (Light or Dark) the file meant it for. */
export interface ImportedTheme {
  file: ThemeFile;
  slot: Half;
}

/** T3 Code role → the VS Code keys it fills. */
const T3_TO_VSCODE: Record<string, string[]> = {
  canvas: ["editor.background"],
  chrome: ["titleBar.activeBackground"],
  text: ["editor.foreground", "foreground"],
  textMuted: ["descriptionForeground"],
  placeholder: ["input.placeholderForeground", "disabledForeground"],
  border: ["panel.border", "notifications.border", "editorWidget.border"],
  toolbarBorder: ["editorGroup.border"],
  sidebar: ["sideBar.background"],
  sidebarForeground: ["sideBar.foreground"],
  sidebarBorder: ["sideBar.border"],
  accent: ["button.background"],
  accentForeground: ["button.foreground"],
  focus: ["focusBorder"],
  secondary: ["button.secondaryBackground", "badge.background"],
  secondaryForeground: ["badge.foreground"],
  toolbarControlHover: ["toolbar.hoverBackground"],
  input: ["input.border"],
  sidebarRowHover: ["list.hoverBackground"],
  sidebarRowActive: ["list.activeSelectionBackground"],
  sidebarRowSelected: ["list.inactiveSelectionBackground"],
  muted: ["keybindingLabel.background"],
  mutedForeground: ["keybindingLabel.foreground"],
  surfaceOverlay: ["menu.background", "quickInput.background", "editorWidget.background"],
  accentSurface: ["menu.selectionBackground", "quickInputList.focusBackground"],
  accentSurfaceForeground: ["menu.selectionForeground", "quickInputList.focusForeground"],
  surfaceRaised: ["notifications.background"],
  terminalSelection: ["editor.selectionBackground"],
  errorForeground: ["errorForeground"],
  warningForeground: ["editorWarning.foreground"],
  updateForeground: ["editorInfo.foreground"],
  terminalScrollbar: ["scrollbarSlider.background"],
  terminalScrollbarHover: ["scrollbarSlider.hoverBackground"],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isHalf = (value: unknown): value is Half => value === "light" || value === "dark";

/** A T3 Code theme file: version 1 with an `appearance` (Pheeme's own files say `kind`). */
export function isT3Theme(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.version === THEME_FILE_VERSION &&
    isHalf(value.appearance) &&
    value.kind === undefined
  );
}

/** Only the entries that are colors. */
function colorsOf(value: unknown): Record<string, string> {
  const colors: Record<string, string> = {};
  if (!isRecord(value)) return colors;
  for (const [role, color] of Object.entries(value))
    if (typeof color === "string" && toCanonicalThemeColor(color)) colors[role] = color;
  return colors;
}

/** A Pheeme theme from T3 Code role colors. Light or dark follows the background, not the half. */
export function themeFromT3Colors(
  name: string,
  t3Colors: Record<string, string>,
  seeds?: ThemeSeeds,
): ThemeFile {
  const colors: Record<string, string> = {};
  for (const [role, keys] of Object.entries(T3_TO_VSCODE)) {
    const value = t3Colors[role];
    if (value) for (const key of keys) colors[key] ??= value;
  }
  if (!colors["editor.background"])
    throw new Error(`${name} has no "canvas" color, so there is nothing to build a theme from.`);
  const type = isDarkColor(colors["editor.background"]) ? "dark" : "light";
  const file = parseVsCodeTheme({ name, type, colors });
  return seeds ? { ...file, seeds } : file;
}

/** The theme Pheeme's editor builds from just a background and an accent. */
export function themeFromSeeds(name: string, seeds: ThemeSeeds): ThemeFile {
  return themeFromT3Colors(name, createVividThemeColors(seeds.background, seeds.accent), seeds);
}

/**
 * Every theme in a T3 Code file: one per half it defines. With both halves, each
 * is named for its half ("Nocturnal · Light") and meant for that mode.
 * Throws an Error whose message can be shown as is.
 */
export function parseT3Theme(value: unknown, fileName?: string): ImportedTheme[] {
  if (!isRecord(value) || !isHalf(value.appearance))
    throw new Error('A T3 Code theme needs an "appearance" of "light" or "dark".');
  const stem = fileName?.replace(/\.[^.]+$/, "");
  const name =
    (typeof value.name === "string" && value.name.trim()) ||
    (typeof value.label === "string" && value.label.trim()) ||
    stem ||
    "T3 Code theme";

  const seedOf = (key: "canvas" | "accent") =>
    typeof value[key] === "string" && toCanonicalThemeColor(value[key] as string)
      ? (value[key] as string)
      : null;
  const background = seedOf("canvas");
  const accent = seedOf("accent");
  const seeds = background && accent ? { background, accent } : undefined;

  const halves: [Half, Record<string, string>][] = [[value.appearance, colorsOf(value.colors)]];
  if (isRecord(value.variants))
    for (const [half, colors] of Object.entries(value.variants))
      if (isHalf(half) && half !== value.appearance) halves.push([half, colorsOf(colors)]);

  const both = halves.length > 1;
  return halves.map(([slot, colors]) => {
    const label = both ? `${name} · ${slot === "light" ? "Light" : "Dark"}` : name;
    // A file with only its two starting colors is built the way T3 built it, and
    // stays editable from those two colors. Seeds describe the first half only.
    const generated = seeds && slot === value.appearance && !colors.canvas ? seeds : undefined;
    const full = generated
      ? { ...createVividThemeColors(generated.background, generated.accent), ...colors }
      : colors;
    return { file: themeFromT3Colors(label, full, generated), slot };
  });
}
