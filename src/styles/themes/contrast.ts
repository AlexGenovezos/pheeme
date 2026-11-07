import {
  contrastRatio,
  flattenOnto,
  isTranslucent,
  mixColors,
  readableThemeColorOn,
  scaleAlpha,
  withAlpha,
} from "./color";
import { THEME_TOKENS, type ThemeToken } from "./schema";

/**
 * Which colors are drawn on which, and how much contrast each pair needs. The
 * built-in themes are tested against this table, and imported themes are
 * adjusted until they pass it (`makeReadable`).
 */
type Tokens = Record<ThemeToken, string>;
type Pair = { fg: ThemeToken; bg: ThemeToken; min: number };

const pairs = (min: number, table: [ThemeToken, ThemeToken[]][]): Pair[] =>
  table.flatMap(([fg, bgs]) => bgs.map((bg) => ({ fg, bg, min })));

const AVATARS = [1, 2, 3, 4, 5, 6].map((i) => `--color-avatar-${i}` as ThemeToken);
const ACCOUNTS = [1, 2, 3, 4, 5, 6].map((i) => `--color-account-${i}` as ThemeToken);
export const MAILBOX_TOKENS = (Object.keys(THEME_TOKENS) as ThemeToken[]).filter((k) =>
  k.startsWith("--color-mailbox-"),
);
const MUTED_SURFACES: ThemeToken[] = [
  "--color-pane-bg",
  "--color-sidebar-bg",
  "--color-badge-bg",
  "--color-list-active-bg",
  "--color-list-hover-bg",
  "--color-list-inactive-bg",
  "--color-menu-bg",
];

/** Every text color on each surface it is drawn on: WCAG AA, 4.5:1. Translucent surfaces sit on the pane. */
export const TEXT_PAIRS = pairs(4.5, [
  [
    "--color-foreground",
    [
      "--color-app-bg",
      "--color-list-hover-bg",
      "--color-list-inactive-bg",
      "--color-selection-bg",
      "--color-control-hover-bg",
      "--color-control-active-bg",
    ],
  ],
  ["--color-sidebar-foreground", ["--color-sidebar-bg"]],
  ["--color-foreground-muted", MUTED_SURFACES],
  ["--color-foreground-subtle", MUTED_SURFACES],
  ["--color-link", ["--color-pane-bg", "--color-list-active-bg"]],
  ["--color-accent-foreground", ["--color-accent", "--color-accent-hover"]],
  [
    "--color-button-secondary-foreground",
    ["--color-button-secondary-bg", "--color-button-secondary-hover-bg"],
  ],
  ["--color-input-foreground", ["--color-input-bg"]],
  ["--color-input-placeholder", ["--color-input-bg"]],
  ["--color-list-active-foreground", ["--color-list-active-bg"]],
  ["--color-list-highlight-foreground", ["--color-pane-bg"]],
  ["--color-badge-foreground", ["--color-badge-bg"]],
  ["--color-badge-accent-foreground", ["--color-badge-accent-bg"]],
  ["--color-kbd-foreground", ["--color-kbd-bg"]],
  ["--color-menu-foreground", ["--color-menu-bg"]],
  ["--color-menu-selection-foreground", ["--color-menu-selection-bg"]],
  ["--color-palette-foreground", ["--color-palette-bg"]],
  ["--color-palette-active-foreground", ["--color-palette-active-bg"]],
  ["--color-toast-foreground", ["--color-toast-bg"]],
  ["--color-toast-danger-foreground", ["--color-toast-bg"]],
  ["--color-danger", ["--color-pane-bg", "--color-menu-bg"]],
  ["--color-warning", ["--color-pane-bg"]],
  ["--color-success", ["--color-pane-bg"]],
  ["--color-info", ["--color-pane-bg"]],
  ["--color-avatar-foreground", AVATARS],
]);

/** Indicators that aren't text: 3:1 (WCAG non-text contrast). */
export const NON_TEXT_PAIRS = pairs(3, [
  ["--color-focus-border", ["--color-pane-bg"]],
  ["--color-unread-indicator", ["--color-pane-bg", "--color-list-active-bg"]],
  ...ACCOUNTS.map((a): [ThemeToken, ThemeToken[]] => [a, ["--color-sidebar-bg"]]),
]);

/** --sidebar-selected-tint in tokens.css: a selected mailbox row is tinted with its own color. */
export const SIDEBAR_SELECTED_TINT = 0.12;

const ratio = (t: Tokens, fg: ThemeToken, bg: ThemeToken) =>
  contrastRatio(t[fg], t[bg], t["--color-pane-bg"]);

const mailboxRatios = (t: Tokens, token: ThemeToken) => [
  contrastRatio(t[token], t["--color-sidebar-bg"]),
  contrastRatio(t[token], withAlpha(t[token], SIDEBAR_SELECTED_TINT), t["--color-sidebar-bg"]),
];

const onPane = (t: Tokens, token: ThemeToken) => contrastRatio(t[token], t["--color-pane-bg"]);

/** Every rule a theme breaks, as readable lines (empty when it passes). */
export function contrastFailures(t: Tokens): string[] {
  const failures = [...TEXT_PAIRS, ...NON_TEXT_PAIRS]
    .map((p) => ({ ...p, r: ratio(t, p.fg, p.bg) }))
    .filter(({ r, min }) => r < min)
    .map(({ fg, bg, r }) => `${fg} on ${bg}: ${r.toFixed(2)}`);
  for (const token of MAILBOX_TOKENS) {
    const [plain, selected] = mailboxRatios(t, token);
    if (plain < 4.5) failures.push(`${token} on the sidebar: ${plain.toFixed(2)}`);
    if (selected < 4.5) failures.push(`${token} selected: ${selected.toFixed(2)}`);
  }
  if (onPane(t, "--color-foreground-muted") < onPane(t, "--color-foreground-subtle"))
    failures.push("--color-foreground-subtle is stronger than --color-foreground-muted");
  if (onPane(t, "--color-foreground-subtle") <= onPane(t, "--color-foreground-disabled"))
    failures.push("--color-foreground-disabled is not dimmer than --color-foreground-subtle");
  return failures;
}

/** Shared text that sits on many surfaces. It is fixed against the pane first; the surfaces then make room for it. */
const SHARED_TEXT: ThemeToken[] = [
  "--color-foreground",
  "--color-foreground-muted",
  "--color-foreground-subtle",
  "--color-link",
  "--color-list-highlight-foreground",
  "--color-danger",
  "--color-warning",
  "--color-success",
  "--color-info",
];
const SHARED_INDICATORS: ThemeToken[] = ["--color-focus-border", "--color-unread-indicator"];

/** How far the sidebar must sit from the opposite extreme (black on light themes, white on dark). */
const SIDEBAR_FLOOR = 7;

/** A little over each minimum, so storing the color rounded can't land just under it. */
const MARGIN = 0.05;

/** Lightness-adjust `fg` until it passes on every one of `bgs` (flattened onto the pane). */
function fixForeground(t: Tokens, fg: ThemeToken, bgs: ThemeToken[], min: number) {
  for (let round = 0; round < 3; round++) {
    let changed = false;
    for (const bg of bgs) {
      if (ratio(t, fg, bg) >= min) continue;
      const surface = flattenOnto(t[bg], t["--color-pane-bg"]);
      t[fg] = readableThemeColorOn(t[fg], surface, min + MARGIN);
      changed = true;
    }
    if (!changed) return;
  }
}

/**
 * Tone a surface down toward the pane (or make a translucent one fainter) just
 * enough for every shared color drawn on it to pass. The pane itself passes,
 * so the search always ends.
 */
function toneSurface(t: Tokens, bg: ThemeToken, checks: Pair[]) {
  const passes = () => checks.every((p) => ratio(t, p.fg, bg) >= p.min);
  if (passes()) return;
  const original = t[bg];
  const translucent = isTranslucent(original);
  const at = (amount: number) =>
    translucent
      ? scaleAlpha(original, 1 - amount)
      : mixColors(original, t["--color-pane-bg"], amount);
  let [near, far] = [0, 1];
  t[bg] = at(far);
  if (!passes()) return; // even the pane fails: leave it for the foreground pass
  for (let step = 0; step < 16; step++) {
    const mid = (near + far) / 2;
    t[bg] = at(mid);
    if (passes()) far = mid;
    else near = mid;
  }
  t[bg] = at(Math.min(1, far + 0.01));
}

/**
 * Adjust a theme until it meets every rule in `contrastFailures`: what VS Code
 * themes need on import, since they were never designed for Pheeme's surfaces.
 * Colors move only as far as they must and keep their hue.
 */
export function makeReadable(tokens: Tokens): Tokens {
  const t = { ...tokens };
  const all = [...TEXT_PAIRS, ...NON_TEXT_PAIRS];
  const bgsOf = (fg: ThemeToken, list = all) => list.filter((p) => p.fg === fg).map((p) => p.bg);

  // 0. A mid-grey sidebar can't carry colored text and its own tint of it at 4.5:1:
  //    nudge it toward the pane's side (lighter on a light theme, darker on a dark one).
  const paneIsLight =
    contrastRatio(t["--color-pane-bg"], "#000000") >=
    contrastRatio(t["--color-pane-bg"], "#ffffff");
  t["--color-sidebar-bg"] = readableThemeColorOn(
    flattenOnto(t["--color-sidebar-bg"], t["--color-pane-bg"]),
    paneIsLight ? "#000000" : "#ffffff",
    SIDEBAR_FLOOR,
  );
  if (t["--color-sidebar-bg"] !== tokens["--color-sidebar-bg"])
    t["--color-sidebar-vibrant-bg"] = withAlpha(t["--color-sidebar-bg"], 0.4); // as build.ts derives it

  // 1. Shared text and indicators, readable on the pane.
  for (const fg of SHARED_TEXT) fixForeground(t, fg, ["--color-pane-bg"], 4.5);
  for (const fg of SHARED_INDICATORS) fixForeground(t, fg, ["--color-pane-bg"], 3);

  // 2. Surfaces carrying shared text give way to it.
  const shared = new Set([...SHARED_TEXT, ...SHARED_INDICATORS]);
  const surfaces = new Set(all.filter((p) => shared.has(p.fg)).map((p) => p.bg));
  surfaces.delete("--color-pane-bg");
  surfaces.delete("--color-app-bg");
  for (const bg of surfaces) {
    toneSurface(
      t,
      bg,
      all.filter((p) => p.bg === bg && shared.has(p.fg)),
    );
  }

  // 3. Everything else: each foreground on its own surfaces. Avatars move the
  //    swatch instead, since one foreground sits on all six.
  for (const avatar of AVATARS) {
    if (ratio(t, "--color-avatar-foreground", avatar) < 4.5)
      t[avatar] = readableThemeColorOn(t[avatar], t["--color-avatar-foreground"], 4.5 + MARGIN);
  }
  for (const fg of new Set(all.map((p) => p.fg))) {
    if (fg === "--color-avatar-foreground") continue;
    const min = TEXT_PAIRS.some((p) => p.fg === fg) ? 4.5 : 3;
    fixForeground(t, fg, bgsOf(fg), min);
    // A color on two surfaces either side of it (a mid-tone accent and its hover)
    // can't move far enough: move the surface instead, unless shared text needs it.
    for (const bg of bgsOf(fg)) {
      if (ratio(t, fg, bg) >= min || surfaces.has(bg) || isTranslucent(t[bg])) continue;
      t[bg] = readableThemeColorOn(t[bg], t[fg], min + MARGIN);
    }
  }

  // 4. Mailbox colors are text on the sidebar and on their own tint of it.
  for (const token of MAILBOX_TOKENS) {
    for (let round = 0; round < 4 && Math.min(...mailboxRatios(t, token)) < 4.5; round++) {
      const tinted = flattenOnto(
        withAlpha(t[token], SIDEBAR_SELECTED_TINT),
        t["--color-sidebar-bg"],
      );
      t[token] = readableThemeColorOn(t[token], t["--color-sidebar-bg"], 4.5 + MARGIN);
      t[token] = readableThemeColorOn(t[token], tinted, 4.5 + MARGIN);
    }
  }

  // 5. Disabled text stays dimmer than subtle text, which stays no stronger than muted.
  if (onPane(t, "--color-foreground-subtle") > onPane(t, "--color-foreground-muted"))
    t["--color-foreground-subtle"] = t["--color-foreground-muted"];
  for (
    let amount = 0.3;
    amount <= 1 &&
    onPane(t, "--color-foreground-disabled") >= onPane(t, "--color-foreground-subtle");
    amount += 0.1
  ) {
    t["--color-foreground-disabled"] = mixColors(
      t["--color-foreground-subtle"],
      t["--color-pane-bg"],
      amount,
    );
  }
  return t;
}
