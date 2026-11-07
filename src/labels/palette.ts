/** Gmail's label palette: every colour the Gmail API accepts (`src-tauri/src/gmail/palette.rs`). */

import type { LabelColor, LabelInfo } from "../lib/tauri";
import { darkTheme, lightTheme } from "../styles/themes";
import { contrastRatio, themeColorToHex } from "../styles/themes/color";

/** The 64 colours of Gmail web's picker grid, then 38 more the API still accepts. */
export const LABEL_ALLOWED: readonly string[] = [
  "#000000",
  "#434343",
  "#666666",
  "#999999",
  "#cccccc",
  "#efefef",
  "#f3f3f3",
  "#ffffff",
  "#fb4c2f",
  "#ffad47",
  "#fad165",
  "#16a766",
  "#43d692",
  "#4a86e8",
  "#a479e2",
  "#f691b3",
  "#f6c5be",
  "#ffe6c7",
  "#fef1d1",
  "#b9e4d0",
  "#c6f3de",
  "#c9daf8",
  "#e4d7f5",
  "#fcdee8",
  "#efa093",
  "#ffd6a2",
  "#fce8b3",
  "#89d3b2",
  "#a0eac9",
  "#a4c2f4",
  "#d0bcf1",
  "#fbc8d9",
  "#e66550",
  "#ffbc6b",
  "#fcda83",
  "#44b984",
  "#68dfa9",
  "#6d9eeb",
  "#b694e8",
  "#f7a7c0",
  "#cc3a21",
  "#eaa041",
  "#f2c960",
  "#149e60",
  "#3dc789",
  "#3c78d8",
  "#8e63ce",
  "#e07798",
  "#ac2b16",
  "#cf8933",
  "#d5ae49",
  "#0b804b",
  "#2a9c68",
  "#285bac",
  "#653e9b",
  "#b65775",
  "#822111",
  "#a46a21",
  "#aa8831",
  "#076239",
  "#1a764d",
  "#1c4587",
  "#41236d",
  "#83334c",
  "#464646",
  "#e7e7e7",
  "#0d3472",
  "#b6cff5",
  "#0d3b44",
  "#98d7e4",
  "#3d188e",
  "#e3d7ff",
  "#711a36",
  "#fbd3e0",
  "#8a1c0a",
  "#f2b2a8",
  "#7a2e0b",
  "#ffc8af",
  "#7a4706",
  "#ffdeb5",
  "#594c05",
  "#fbe983",
  "#684e07",
  "#fdedc1",
  "#0b4f30",
  "#b3efd3",
  "#04502e",
  "#a2dcc1",
  "#c2c2c2",
  "#4986e7",
  "#2da2bb",
  "#b99aff",
  "#994a64",
  "#f691b2",
  "#ff7537",
  "#ffad46",
  "#662e37",
  "#ebdbde",
  "#cca6ac",
  "#094228",
  "#42d692",
  "#16a765",
];

/** Whether the Gmail API accepts `hex` as a label colour (case-insensitive). */
export function isAllowedColor(hex: string): boolean {
  const lower = hex.toLowerCase();
  return LABEL_ALLOWED.includes(lower);
}

/** The 64 colours of Gmail web's picker grid, in grid order (`LABEL_BACKGROUNDS` in Rust). */
export const LABEL_BACKGROUNDS: readonly string[] = LABEL_ALLOWED.slice(0, 64);

/** A label colour pair for `background`, text black or white by higher contrast (Rust `text_for`). */
export function labelColor(background: string): LabelColor {
  const bg = background.toLowerCase();
  const white = contrastRatio("#ffffff", bg);
  const black = contrastRatio("#000000", bg);
  return { background: bg, text: white > black ? "#ffffff" : "#000000" };
}

const MIN_TEXT_CONTRAST = 4.5;
/** Below this against the pane, a chip would melt into it and needs an outline. */
const MIN_EDGE_CONTRAST = 1.3;
const DARK_TEXT = themeColorToHex(lightTheme.tokens["--color-foreground"]);
const PANES = [lightTheme, darkTheme].map((t) => t.tokens["--color-pane-bg"]);

export interface ChipColors {
  background: string;
  color: string;
  /** The background is too close to the pane's in either theme. */
  border: boolean;
}

/**
 * How a coloured label draws as a chip: Gmail's background, with Gmail's text colour when it reads (4.5:1) and
 * otherwise whichever of dark foreground or white reads better. `null` for a label without a colour.
 */
export function chipColors(label: LabelInfo): ChipColors | null {
  const background = label.colorBackground?.toLowerCase();
  if (!background) return null;
  let color = label.colorText?.toLowerCase() ?? labelColor(background).text;
  if (contrastRatio(color, background) < MIN_TEXT_CONTRAST) {
    color = [DARK_TEXT, "#ffffff"].reduce((best, c) =>
      contrastRatio(c, background) > contrastRatio(best, background) ? c : best,
    );
  }
  return {
    background,
    color,
    border: PANES.some((pane) => contrastRatio(background, pane) < MIN_EDGE_CONTRAST),
  };
}
