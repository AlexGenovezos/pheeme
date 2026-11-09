import { create } from "zustand";
import { DERIVED_TOKENS } from "../../styles/themes/build";
import { themeColorToHex, toCanonicalThemeColor } from "../../styles/themes/color";
import { makeReadable } from "../../styles/themes/contrast";
import type { ThemeDefinition, ThemeToken } from "../../styles/themes/schema";
import { themeFromSeeds } from "../../styles/themes/t3";
import {
  colorKey,
  MAX_THEME_NAME_LENGTH,
  RESERVED_THEME_IDS,
  THEME_FILE_VERSION,
  type ThemeFile,
  type ThemeSeeds,
  themeFileFromTokens,
  themeIdFromName,
} from "../../styles/themes/themeFile";
import { isDarkColor } from "../../styles/themes/vivid";
import {
  availableThemes,
  definitionOf,
  previewTheme,
  type ResolvedTheme,
  themeFileById,
  themeFor,
  useThemeStore,
} from "../theme";

/**
 * The theme editor (T3 Code's, ported): a floating panel over the app that edits
 * one theme with a live preview. Simple mode builds the whole palette from a
 * background and an accent; advanced mode sets any color. Nothing is saved until
 * Save; closing puts the chosen theme back.
 */

const DERIVED = new Set<string>(DERIVED_TOKENS.map(colorKey));

interface EditorState {
  open: boolean;
  /** The custom theme being edited (saved over on Save), or null for a new theme. */
  editingId: string | null;
  draft: ThemeFile;
  /** Light or Dark mode: which one the theme is chosen for on Save. */
  slot: ResolvedTheme;
  advanced: boolean;
  /** The background and accent simple mode shows (and builds from once changed). */
  seeds: ThemeSeeds;
  /** Derived colors set by hand, which stop following their base color. */
  pinned: string[];
  dirty: boolean;
  /** Whether Settings was open, to reopen it when the editor closes. */
  fromSettings: boolean;
  minimized: boolean;
}

const blank: ThemeFile = {
  version: THEME_FILE_VERSION,
  id: "",
  name: "",
  kind: "dark",
  colors: {},
};

export const useThemeEditorStore = create<EditorState>(() => ({
  open: false,
  editingId: null,
  draft: blank,
  slot: "dark",
  advanced: false,
  seeds: { background: "#000000", accent: "#ffffff" },
  pinned: [],
  dirty: false,
  fromSettings: false,
  minimized: false,
}));

const hexOf = (value: string) => themeColorToHex(value).slice(0, 7);

/** The draft as a full theme, ready to apply. */
export function draftTheme(draft: ThemeFile): ThemeDefinition {
  return definitionOf(draft);
}

function seedsOf(theme: ThemeDefinition, file: ThemeFile | null): ThemeSeeds {
  return (
    file?.seeds ?? {
      background: hexOf(theme.tokens["--color-app-bg"]),
      accent: hexOf(theme.tokens["--color-accent"]),
    }
  );
}

function update(patch: Partial<EditorState>) {
  useThemeEditorStore.setState({ ...patch, dirty: true });
  previewTheme(draftTheme(useThemeEditorStore.getState().draft));
}

/** A name no other theme has: "Harbour", then "Harbour 2", … */
function uniqueName(base: string, except: string | null) {
  const { customThemes, folderThemes } = useThemeStore.getState();
  const taken = new Set(
    availableThemes(customThemes, folderThemes)
      .filter((t) => t.id !== except)
      .flatMap((t) => [t.name.toLowerCase(), t.id]),
  );
  const fits = (name: string) =>
    !taken.has(name.toLowerCase()) &&
    !taken.has(themeIdFromName(name)) &&
    !RESERVED_THEME_IDS.has(themeIdFromName(name));
  const stem = base.slice(0, MAX_THEME_NAME_LENGTH - 3).trim();
  if (fits(base)) return base;
  for (let n = 2; ; n++) if (fits(`${stem} ${n}`)) return `${stem} ${n}`;
}

/**
 * Open the editor on theme `id` (a custom theme is edited in place; a built-in or
 * themes-folder theme is copied), or on a new theme starting from what's showing.
 */
export function openThemeEditor({
  id,
  slot,
  fromSettings = false,
}: {
  id?: string;
  slot?: ResolvedTheme;
  fromSettings?: boolean;
}) {
  const store = useThemeStore.getState();
  const showing = slot ?? store.resolved;
  const themeId = id ?? store.choices[showing];
  const file = themeFileById(themeId);
  const editable =
    file !== null && store.customThemes.some((t) => t.id === themeId) && id !== undefined;
  const theme = file
    ? definitionOf(file)
    : themeFor(showing, { ...store.choices, [showing]: themeId }, [], []);
  const name = editable
    ? file.name
    : uniqueName(id === undefined ? "My theme" : `${theme.name} copy`, null);
  const draft: ThemeFile = editable
    ? file
    : {
        ...themeFileFromTokens({ id: themeIdFromName(name), name, kind: theme.kind }, theme.tokens),
        ...(file?.seeds && { seeds: file.seeds }),
      };
  useThemeEditorStore.setState({
    open: true,
    editingId: editable ? file.id : null,
    draft,
    slot: showing,
    advanced: !draft.seeds && editable,
    seeds: seedsOf(theme, file),
    pinned: [],
    dirty: false,
    fromSettings,
    minimized: false,
  });
  previewTheme(draftTheme(draft));
}

export function setDraftName(name: string) {
  const { draft } = useThemeEditorStore.getState();
  update({ draft: { ...draft, name } });
}

export function setSlot(slot: ResolvedTheme) {
  useThemeEditorStore.setState({ slot, dirty: true });
}

export function setAdvanced(advanced: boolean) {
  useThemeEditorStore.setState({ advanced });
}

export function setMinimized(minimized: boolean) {
  useThemeEditorStore.setState({ minimized });
}

/** A hand edit: the theme no longer is what its two colors build. */
function withoutSeeds(draft: ThemeFile): ThemeFile {
  const copy = { ...draft };
  delete copy.seeds;
  return copy;
}

/** Simple mode: rebuild every color from the background and accent. */
export function setSeed(which: keyof ThemeSeeds, value: string) {
  const color = toCanonicalThemeColor(value);
  const { draft, seeds } = useThemeEditorStore.getState();
  const next = { ...seeds, [which]: value };
  if (!color) return useThemeEditorStore.setState({ seeds: next });
  const built = themeFromSeeds(draft.name || "Theme", {
    background: next.background,
    accent: next.accent,
  });
  update({
    seeds: next,
    pinned: [],
    draft: { ...draft, kind: built.kind, colors: built.colors, seeds: built.seeds },
  });
}

/**
 * Advanced mode: set one color. Changing a base color lets the colors derived
 * from it (hover states and the like) follow, unless they were set by hand.
 */
export function setColor(token: ThemeToken, value: string) {
  const color = toCanonicalThemeColor(value);
  if (!color) return;
  const { draft, pinned } = useThemeEditorStore.getState();
  const key = colorKey(token);
  const colors = { ...draft.colors, [key]: color };
  const nextPinned = DERIVED.has(key) ? [...new Set([...pinned, key])] : pinned;
  if (!DERIVED.has(key))
    for (const derived of DERIVED) if (!nextPinned.includes(derived)) delete colors[derived];
  const appBg = colors["app-bg"] ?? draftTheme(draft).tokens["--color-app-bg"];
  update({
    pinned: nextPinned,
    draft: { ...withoutSeeds(draft), kind: isDarkColor(hexOf(appBg)) ? "dark" : "light", colors },
  });
}

/** Adjust every text color until it is readable, as an import does. */
export function fixContrast() {
  const { draft } = useThemeEditorStore.getState();
  const tokens = makeReadable(draftTheme(draft).tokens);
  const fixed = themeFileFromTokens(draft, tokens);
  update({ draft: { ...withoutSeeds(draft), colors: fixed.colors } });
}

/** Put the chosen theme back and close. */
export function closeThemeEditor(): boolean {
  const { fromSettings } = useThemeEditorStore.getState();
  useThemeEditorStore.setState({ open: false, dirty: false });
  previewTheme(null);
  return fromSettings;
}

/** Save the draft as a custom theme (over the one being edited), choose it for its mode, and close. */
export function saveThemeEditor(): boolean {
  const { draft, editingId, slot } = useThemeEditorStore.getState();
  const typed = draft.name.trim().slice(0, MAX_THEME_NAME_LENGTH) || "My theme";
  // A new theme never replaces another: its name (and so its id) is made unique.
  const name = editingId ? typed : uniqueName(typed, null);
  const file: ThemeFile = { ...draft, id: editingId ?? themeIdFromName(name), name };
  // Clear the preview first so installing commits the saved theme, not the draft.
  previewTheme(null);
  useThemeStore.getState().installThemes([{ file, slot }]);
  return closeThemeEditor();
}
