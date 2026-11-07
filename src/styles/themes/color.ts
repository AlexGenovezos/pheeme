import {
  converter,
  formatHex,
  formatHex8,
  interpolate,
  parse,
  toGamut,
  wcagContrast,
  type Oklch,
} from "culori";

/**
 * Color math for themes, in OKLCH so lightness steps look even across hues.
 * Every theme color is stored as canonical `oklch(L C h[ / a])`, mapped into
 * sRGB so it renders the same everywhere. Modeled on T3 Code's themePalette.ts.
 */

const toOklch = converter("oklch");
const toRgb = converter("rgb");
const intoSrgb = toGamut("rgb", "oklch");

function parseOklch(value: string): Oklch | null {
  const parsed = parse(value.trim());
  if (!parsed) return null;
  const color = toOklch(parsed);
  const alpha = color.alpha ?? 1;
  if (![color.l, color.c ?? 0, color.h ?? 0, alpha].every(Number.isFinite)) return null;
  return { mode: "oklch", l: color.l, c: color.c ?? 0, h: color.h ?? 0, alpha };
}

function requireColor(value: string): Oklch {
  const color = parseOklch(value);
  if (!color) throw new Error(`"${value}" is not a CSS color`);
  return color;
}

const num = (value: number, digits: number) => {
  const fixed = value.toFixed(digits).replace(/\.?0+$/, "");
  return fixed === "-0" ? "0" : fixed;
};

/** Within sRGB, allowing for rounding: a stored color on the gamut edge must read back unchanged. */
function inSrgb(color: Oklch): boolean {
  const { r, g, b } = toRgb(color);
  return [r, g, b].every((v) => v > -1e-4 && v < 1 + 1e-4);
}

function format(color: Oklch): string {
  const mapped = inSrgb(color) ? color : toOklch(intoSrgb(color));
  const l = Math.min(1, Math.max(0, mapped.l));
  const c = mapped.c ?? 0;
  const h = c < 1e-6 ? 0 : (((mapped.h ?? 0) % 360) + 360) % 360;
  const alpha = Math.min(1, Math.max(0, color.alpha ?? 1));
  const body = `${num(l, 6)} ${num(c, 6)} ${num(h, 3)}`;
  return alpha < 1 ? `oklch(${body} / ${num(alpha, 4)})` : `oklch(${body})`;
}

/** Any CSS color as canonical, sRGB-mapped `oklch(...)`, or null when it isn't a color. */
export function toCanonicalThemeColor(value: string): string | null {
  const color = parseOklch(value);
  return color ? format(color) : null;
}

/** `#rrggbb`, or `#rrggbbaa` when translucent: for APIs that take hex (the native window). */
export function themeColorToHex(value: string): string {
  const color = intoSrgb(requireColor(value));
  return (color.alpha ?? 1) < 1 ? formatHex8(color) : formatHex(color);
}

/** The same color at a different opacity. */
export function withAlpha(value: string, alpha: number): string {
  return format({ ...requireColor(value), alpha });
}

/** Multiply a translucent color's opacity, e.g. a hover state that is a shade stronger. */
export function scaleAlpha(value: string, factor: number): string {
  const color = requireColor(value);
  return format({ ...color, alpha: Math.min(1, (color.alpha ?? 1) * factor) });
}

/**
 * Shift OKLCH lightness by `amount`: darker on a light theme, lighter on a dark one.
 * Darkening scales chroma down with lightness, so a darker shade doesn't turn more vivid.
 */
export function emphasize(value: string, kind: "light" | "dark", amount: number): string {
  const color = requireColor(value);
  const l = Math.min(1, Math.max(0, color.l + (kind === "light" ? -amount : amount)));
  const c = l < color.l && color.l > 0 ? (color.c * l) / color.l : color.c;
  return format({ ...color, l, c });
}

/** Composite a possibly translucent color over an opaque one. */
function flatten(value: Oklch, under: Oklch): Oklch {
  const top = toRgb(value);
  const base = toRgb(under);
  const a = top.alpha ?? 1;
  const mix = (t: number, b: number) => t * a + b * (1 - a);
  return toOklch({
    mode: "rgb",
    r: mix(top.r, base.r),
    g: mix(top.g, base.g),
    b: mix(top.b, base.b),
  });
}

/** `value` composited over the opaque `base`, as an opaque color: what the eye sees. */
export function flattenOnto(value: string, base: string): string {
  return format(flatten(requireColor(value), requireColor(base)));
}

/** `amount` of the way from `from` to `to`, mixed in OKLab (0 gives `from`, 1 gives `to`). */
export function mixColors(from: string, to: string, amount: number): string {
  const t = Math.min(1, Math.max(0, amount));
  return format(toOklch(interpolate([requireColor(from), requireColor(to)], "oklab")(t)));
}

/** Whether a color is see-through (alpha below 1). */
export function isTranslucent(value: string): boolean {
  return (requireColor(value).alpha ?? 1) < 1;
}

/**
 * WCAG contrast of `foreground` on `background`. Translucent colors are composited first:
 * the background over `base` (the surface it sits on), then the foreground over that.
 */
export function contrastRatio(foreground: string, background: string, base = "#ffffff"): number {
  const surface = flatten(requireColor(background), requireColor(base));
  return wcagContrast(flatten(requireColor(foreground), surface), surface);
}

/**
 * Move only the lightness of `color` until it reaches `minContrast` on `surface`,
 * so a color that is too dim keeps its hue instead of collapsing to black or white.
 * Returns the color unchanged when it already passes. Both colors are treated as opaque.
 */
export function readableThemeColorOn(color: string, surface: string, minContrast: number): string {
  const fg = requireColor(color);
  const bg = requireColor(surface);
  const passes = (l: number) => wcagContrast(intoSrgb({ ...fg, l, alpha: 1 }), bg) >= minContrast;
  if (passes(fg.l)) return color;
  // Away from the surface: lighter text on dark surfaces, darker on light ones.
  const lighter = wcagContrast(bg, "#000000") < wcagContrast(bg, "#ffffff");
  let [near, far] = [fg.l, lighter ? 1 : 0];
  if (!passes(far)) return format({ ...fg, l: far, alpha: 1 });
  for (let step = 0; step < 24; step++) {
    const mid = (near + far) / 2;
    if (passes(mid)) far = mid;
    else near = mid;
  }
  // A hair past the boundary, so rounding the stored value can't land just under it.
  const l = Math.min(1, Math.max(0, far + (lighter ? 1e-4 : -1e-4)));
  return format({ ...fg, l, alpha: 1 });
}
