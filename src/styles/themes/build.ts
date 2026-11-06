import {
  emphasize,
  readableThemeColorOn,
  scaleAlpha,
  toCanonicalThemeColor,
  withAlpha,
} from "./color";
import { THEME_TOKENS, type ThemeDefinition, type ThemeToken } from "./schema";

type Kind = ThemeDefinition["kind"];
type Derive = (tokens: Record<ThemeToken, string>, kind: Kind) => string;

/**
 * Tokens worked out from others, so a theme only writes its base colors (T3's
 * createVividThemeColors does the same). A theme can still set any of these to
 * override the derived value. Order matters: a rule may read tokens derived above it.
 */
const DERIVED = {
  // Same surface or text as their base.
  "--color-pane-bg": (t) => t["--color-app-bg"],
  "--color-titlebar-bg": (t) => t["--color-app-bg"],
  "--color-menu-border": (t) => t["--color-border"],
  "--color-input-foreground": (t) => t["--color-foreground"],
  "--color-button-secondary-foreground": (t) => t["--color-foreground"],
  "--color-menu-foreground": (t) => t["--color-foreground"],
  "--color-palette-foreground": (t) => t["--color-foreground"],
  "--color-palette-active-foreground": (t) => t["--color-list-active-foreground"],
  "--color-list-highlight-foreground": (t) => t["--color-link"],
  "--color-badge-accent-bg": (t) => t["--color-accent"],
  "--color-badge-accent-foreground": (t) => t["--color-accent-foreground"],

  // Interaction states: a step away from the background, or a stronger tint.
  "--color-accent-hover": (t, kind) => emphasize(t["--color-accent"], kind, 0.05),
  "--color-button-secondary-hover-bg": (t, kind) =>
    emphasize(t["--color-button-secondary-bg"], kind, 0.035),
  "--color-control-active-bg": (t) => scaleAlpha(t["--color-control-hover-bg"], 1.75),
  "--color-scrollbar-thumb-hover": (t) => scaleAlpha(t["--color-scrollbar-thumb"], 1.7),
  "--color-sidebar-vibrant-bg": (t) => withAlpha(t["--color-sidebar-bg"], 0.4),

  // The danger color, made readable on the toast (which is dark in the light theme).
  "--color-toast-danger-foreground": (t) =>
    readableThemeColorOn(t["--color-danger"], t["--color-toast-bg"], 4.5),
} satisfies Partial<Record<ThemeToken, Derive>>;

export type DerivedToken = keyof typeof DERIVED;
export const DERIVED_TOKENS = Object.keys(DERIVED) as DerivedToken[];

/** What a theme file writes: every base token, plus overrides for any derived one. */
export interface ThemeSource extends Omit<ThemeDefinition, "tokens"> {
  tokens: Record<Exclude<ThemeToken, DerivedToken>, string> & Partial<Record<DerivedToken, string>>;
}

/** Tokens whose value is not a single color (full box-shadow values). */
const isColorToken = (token: string) => token.startsWith("--color-");

/** Fill in derived tokens and store every color as canonical OKLCH. Throws on a value that isn't a color. */
export function buildTheme(source: ThemeSource): ThemeDefinition {
  const tokens = { ...source.tokens } as Record<ThemeToken, string>;
  for (const [token, derive] of Object.entries(DERIVED) as [DerivedToken, Derive][]) {
    tokens[token] ??= derive(tokens, source.kind);
  }
  for (const token of Object.keys(THEME_TOKENS) as ThemeToken[]) {
    if (tokens[token] === undefined) throw new Error(`${source.id} is missing ${token}`);
    if (!isColorToken(token)) continue;
    const color = toCanonicalThemeColor(tokens[token]);
    if (!color) throw new Error(`${source.id}: ${token} is not a color: "${tokens[token]}"`);
    tokens[token] = color;
  }
  return { ...source, tokens };
}
