import { converter, formatHex, parse, toGamut, wcagContrast, type Oklch, type Rgb } from "culori";

/**
 * A whole palette from two colors, a background and an accent: T3 Code's
 * createVividThemeColors, ported. Surfaces are steps away from the background,
 * tinted with the accent's hue; text is solved for contrast against them.
 * Returns colors under T3 Code's role names (t3.ts maps those onto Pheeme's).
 */

const toOklch = converter("oklch");
const toRgb = converter("rgb");
const intoSrgb = toGamut("rgb", "oklch");

type L = { L: number; C: number; h: number };

const rgbOf = (value: string, fallback: string): Rgb => {
  const parsed = parse(value.trim()) ?? parse(fallback)!;
  const { r, g, b } = toRgb(parsed);
  return { mode: "rgb", r, g, b };
};
const oklchOf = (rgb: Rgb): L => {
  const c = toOklch(rgb);
  return { L: c.l, C: c.c ?? 0, h: c.h ?? 0 };
};
const rgbFromL = ({ L, C, h }: L): Rgb => {
  const { r, g, b } = intoSrgb({ mode: "oklch", l: L, c: C, h } satisfies Oklch);
  return { mode: "rgb", r, g, b };
};
const hex = (rgb: Rgb) => formatHex(rgb);
const luminance = (rgb: Rgb) => {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
};
const contrast = (a: Rgb, b: Rgb) => wcagContrast(a, b);
const mix = (from: Rgb, to: Rgb, amount: number): Rgb => ({
  mode: "rgb",
  r: from.r + (to.r - from.r) * amount,
  g: from.g + (to.g - from.g) * amount,
  b: from.b + (to.b - from.b) * amount,
});

const LIGHT_FOREGROUND = rgbOf("#fffaff", "#fff");
const DARK_FOREGROUND = rgbOf("#241523", "#000");
const WHITE = rgbOf("#ffffff", "#fff");
const BLACK = rgbOf("#000000", "#000");

/** At luminance 0.179, black and white text have equal contrast. */
export const isDarkColor = (value: string) => luminance(rgbOf(value, "#000")) < 0.179;

/** Move only lightness until `base` reaches `min` contrast on every surface in `against`. */
function solveLightness(base: L, against: Rgb[], min: number, dir: "lighter" | "darker"): L {
  const worst = (c: L) => Math.min(...against.map((s) => contrast(rgbFromL(c), s)));
  if (worst(base) >= min) return base;
  let low = dir === "lighter" ? base.L : 0;
  let high = dir === "lighter" ? 1 : base.L;
  for (let step = 0; step < 18; step++) {
    const mid = (low + high) / 2;
    const passes = worst({ ...base, L: mid }) >= min;
    if (dir === "lighter") [low, high] = passes ? [low, mid] : [mid, high];
    else [low, high] = passes ? [mid, high] : [low, mid];
  }
  return { ...base, L: dir === "lighter" ? high : low };
}

function readableForeground(background: Rgb): Rgb {
  const light = contrast(background, LIGHT_FOREGROUND);
  const dark = contrast(background, DARK_FOREGROUND);
  if (Math.max(light, dark) >= 4.5) return light >= dark ? LIGHT_FOREGROUND : DARK_FOREGROUND;
  return contrast(background, WHITE) >= contrast(background, BLACK) ? WHITE : BLACK;
}

/** `foreground` softened toward `background` as far as `amount`, but never below `min` contrast. */
function readableText(background: Rgb, foreground: Rgb, amount: number, min: number): Rgb {
  const softened = mix(foreground, background, amount);
  if (contrast(softened, background) >= min) return softened;
  let readable = foreground;
  let [low, high] = [0, amount];
  for (let i = 0; i < 12; i++) {
    const mid = (low + high) / 2;
    const candidate = mix(foreground, background, mid);
    if (contrast(candidate, background) >= min) [readable, low] = [candidate, mid];
    else high = mid;
  }
  return readable;
}

const mutedText = (background: Rgb, foreground: Rgb) =>
  readableText(background, foreground, 1, luminance(background) < 0.179 ? 5.082 : 4.705);

const STATUS = {
  light: {
    error: "#fb2c36",
    errorForeground: "#c10007",
    warning: "#fe9a00",
    warningForeground: "#bb4d00",
  },
  dark: {
    error: "#fb414a",
    errorForeground: "#ff6467",
    warning: "#fe9a00",
    warningForeground: "#ffb900",
  },
} as const;

/** T3 Code role → color (hex), for a background and an accent. */
export function createVividThemeColors(background: string, accent: string): Record<string, string> {
  const canvasRgb = rgbOf(background, "#180f1b");
  const accentRgb = rgbOf(accent, "#a84370");
  const canvas = oklchOf(canvasRgb);
  const acc = oklchOf(accentRgb);
  const dark = luminance(canvasRgb) < 0.179;
  const hue = acc.C < 0.02 ? canvas.h : acc.h;
  const tintC = Math.min(0.045, Math.max(0.008, acc.C * 0.22));
  const step = dark ? 1 : -1;
  const surfaceAt = (deltaL: number, chroma = tintC): L => ({
    L: Math.min(0.98, Math.max(0.05, canvas.L + step * deltaL)),
    C: chroma,
    h: hue,
  });
  const color = (c: L) => hex(rgbFromL(c));

  const textBase: L = { L: dark ? 0.95 : 0.2, C: Math.min(0.035, acc.C * 0.25), h: hue };
  const textRgb = rgbFromL(solveLightness(textBase, [canvasRgb], 7, dark ? "lighter" : "darker"));
  const textMutedRgb = mutedText(canvasRgb, textRgb);
  const foregroundOn = (surface: L) =>
    color(solveLightness(textBase, [rgbFromL(surface)], 4.6, dark ? "lighter" : "darker"));

  const sidebar = surfaceAt(0.045, tintC * 1.4);
  const surfaceRaised = surfaceAt(0.05);
  const secondary = surfaceAt(dark ? 0.1 : 0.06, Math.min(0.09, acc.C * 0.5));
  const muted = surfaceAt(dark ? 0.06 : 0.04, Math.min(0.06, acc.C * 0.35));
  const accentSurface = surfaceAt(dark ? 0.13 : 0.08, Math.min(0.11, acc.C * 0.55));
  const updateSurface = surfaceAt(dark ? 0.14 : 0.09, Math.min(0.12, acc.C * 0.55));

  const status = STATUS[dark ? "dark" : "light"];
  const statusSurface = (value: string) => mix(canvasRgb, rgbOf(value, "#f00"), dark ? 0.16 : 0.08);
  const statusOn = (value: string, surface: Rgb) =>
    color(
      solveLightness(oklchOf(rgbOf(value, "#f00")), [surface], 4.6, dark ? "lighter" : "darker"),
    );
  const errorSurface = statusSurface(status.error);
  const warningSurface = statusSurface(status.warning);

  return {
    canvas: hex(canvasRgb),
    chrome: hex(canvasRgb),
    toolbar: hex(canvasRgb),
    toolbarForeground: hex(textRgb),
    toolbarBorder: color(surfaceAt(dark ? 0.14 : 0.1, Math.min(0.08, acc.C * 0.4))),
    toolbarControl: color(surfaceAt(dark ? 0.09 : 0.05, tintC * 1.3)),
    toolbarControlHover: color(surfaceAt(dark ? 0.14 : 0.09, tintC * 1.6)),
    surface: color(surfaceAt(0.015)),
    surfaceRaised: color(surfaceRaised),
    surfaceOverlay: color(surfaceAt(0.075)),
    text: hex(textRgb),
    textMuted: hex(textMutedRgb),
    border: color(surfaceAt(dark ? 0.16 : 0.12, Math.min(0.07, acc.C * 0.35))),
    input: color(surfaceAt(dark ? 0.21 : 0.16, Math.min(0.08, acc.C * 0.4))),
    focus: hex(accentRgb),
    accent: hex(accentRgb),
    accentForeground: hex(readableForeground(accentRgb)),
    secondary: color(secondary),
    secondaryForeground: foregroundOn(secondary),
    muted: color(muted),
    mutedForeground: hex(readableText(rgbFromL(muted), textRgb, 1, 4.6)),
    placeholder: hex(readableText(rgbFromL(surfaceRaised), textRgb, 1, 4.6)),
    update: hex(accentRgb),
    updateForeground: foregroundOn(updateSurface),
    accentSurface: color(accentSurface),
    accentSurfaceForeground: foregroundOn(accentSurface),
    error: status.error,
    errorForeground: statusOn(status.errorForeground, errorSurface),
    warning: status.warning,
    warningForeground: statusOn(status.warningForeground, warningSurface),
    sidebar: color(sidebar),
    sidebarForeground: foregroundOn(sidebar),
    sidebarMutedForeground: hex(mutedText(rgbFromL(sidebar), textRgb)),
    sidebarRowHover: color(surfaceAt(dark ? 0.08 : 0.06, Math.min(0.08, acc.C * 0.45))),
    sidebarRowActive: color(surfaceAt(dark ? 0.12 : 0.09, Math.min(0.1, acc.C * 0.55))),
    sidebarRowSelected: color(surfaceAt(dark ? 0.14 : 0.1, Math.min(0.11, acc.C * 0.6))),
    sidebarBorder: color(surfaceAt(dark ? 0.17 : 0.12, Math.min(0.08, acc.C * 0.4))),
    terminalSelection: color(surfaceAt(dark ? 0.18 : 0.12, Math.min(0.12, acc.C * 0.55))),
    terminalScrollbar: color(surfaceAt(dark ? 0.22 : 0.16, tintC)),
    terminalScrollbarHover: color(surfaceAt(dark ? 0.3 : 0.22, tintC)),
  };
}
