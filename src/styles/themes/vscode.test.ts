import { describe, expect, test } from "vitest";
import { parseThemeText as parseAll } from "../../theme/customThemes";
import { themeColorToHex, toCanonicalThemeColor } from "./color";
import { contrastFailures } from "./contrast";
import { buildThemeFromFile } from "./themeFile";
import { isVsCodeTheme, parseVsCodeTheme } from "./vscode";
import darkModern from "./vscode-fixtures/dark_modern.json?raw";
import hcBlack from "./vscode-fixtures/hc_black.json?raw";
import lightModern from "./vscode-fixtures/light_modern.json?raw";
import monokai from "./vscode-fixtures/monokai-color-theme.json?raw";
import quietLight from "./vscode-fixtures/quietlight-color-theme.json?raw";
import solarizedLight from "./vscode-fixtures/solarized-light-color-theme.json?raw";

/** Real VS Code themes (from microsoft/vscode, MIT), trimmed to their workbench colors. */
const FIXTURES = [
  { file: "dark_modern.json", text: darkModern, kind: "dark", name: "Dark Modern" },
  { file: "light_modern.json", text: lightModern, kind: "light", name: "Light Modern" },
  { file: "hc_black.json", text: hcBlack, kind: "dark", name: "Dark High Contrast" },
  { file: "monokai-color-theme.json", text: monokai, kind: "dark", name: "Monokai" },
  { file: "quietlight-color-theme.json", text: quietLight, kind: "light", name: "Quiet Light" },
  {
    file: "solarized-light-color-theme.json",
    text: solarizedLight,
    kind: "light",
    name: "Solarized (light)",
  },
] as const;

const hex = (value: string) => themeColorToHex(value);
/** A VS Code file holds one theme. */
const parseThemeText = (text: string, file?: string) => parseAll(text, file)[0].file;

describe("VS Code theme import", () => {
  test.each(FIXTURES)("$name imports as a readable $kind theme", ({ file, text, kind, name }) => {
    const theme = parseThemeText(text, file);
    expect(theme).toMatchObject({ kind, name });
    expect(contrastFailures(buildThemeFromFile(theme).tokens)).toEqual([]);
  });

  test("keeps the theme's own colors where they are readable", () => {
    const t = buildThemeFromFile(parseThemeText(darkModern, "dark_modern.json")).tokens;
    expect(hex(t["--color-app-bg"])).toBe("#1f1f1f");
    expect(hex(t["--color-sidebar-bg"])).toBe("#181818");
    expect(hex(t["--color-accent"])).toBe("#0078d4");
    expect(hex(t["--color-input-bg"])).toBe("#313131");
  });

  test("reads JSON with comments and trailing commas, as VS Code writes it", () => {
    const theme = parseThemeText(
      `{
        // a comment
        "name": "commented",
        "type": "dark",
        "colors": { "editor.background": "#202830", /* another */ "button.background": "#3a7bd5", },
      }`,
    );
    expect(theme.kind).toBe("dark");
    expect(hex(buildThemeFromFile(theme).tokens["--color-app-bg"])).toBe("#202830");
  });

  test("a sparse theme fills every color in from its background and text", () => {
    const theme = parseVsCodeTheme({
      name: "sparse",
      colors: { "editor.background": "#fdf6e3", "editor.foreground": "#ff00ff" },
    });
    expect(theme.kind).toBe("light");
    const t = buildThemeFromFile(theme).tokens;
    expect(contrastFailures(t)).toEqual([]);
    // Neutral surfaces are mixed from this theme's colors, not taken from Pheeme Light.
    expect(hex(t["--color-sidebar-bg"])).toBe("#fdf6e3");
  });

  test("dim text is lifted until it reads, keeping its hue", () => {
    const theme = parseVsCodeTheme({
      type: "dark",
      colors: { "editor.background": "#101010", descriptionForeground: "#303a60" },
    });
    const t = buildThemeFromFile(theme).tokens;
    expect(contrastFailures(t)).toEqual([]);
    const hue = (v: string) => Number(/ ([\d.]+)\)$/.exec(toCanonicalThemeColor(v)!)![1]);
    expect(Math.abs(hue(t["--color-foreground-muted"]) - hue("#303a60"))).toBeLessThan(3);
  });

  test("a theme named like a built-in gets its own id", () => {
    const theme = parseVsCodeTheme({ name: "Dark", colors: { "editor.background": "#000" } });
    expect(theme.id).toBe("dark-vscode");
  });

  test("names come from displayName, name, then the file", () => {
    const colors = { "editor.background": "#000000" };
    expect(parseVsCodeTheme({ displayName: "Night Owl", name: "x", colors }).name).toBe(
      "Night Owl",
    );
    expect(parseVsCodeTheme({ name: "night-owl", colors }).name).toBe("Night Owl");
    expect(parseVsCodeTheme({ colors }, "tokyo-night-color-theme.json").name).toBe("Tokyo Night");
  });

  test("a theme with no background and no type is refused", () => {
    expect(() => parseVsCodeTheme({ colors: { "editor.foreground": "#fff" } })).toThrow(
      /editor\.background/,
    );
  });

  test("tells VS Code themes from Pheeme theme files", () => {
    expect(isVsCodeTheme({ colors: { "editor.background": "#000" } })).toBe(true);
    expect(isVsCodeTheme({ tokenColors: [] })).toBe(true);
    expect(isVsCodeTheme({ version: 1, colors: { "app-bg": "#000" } })).toBe(false);
  });
});

describe("VS Code import on arbitrary colors", () => {
  /** Deterministic pseudo-random numbers (mulberry32), so a failure reproduces. */
  function random(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let n = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      n = (n + Math.imul(n ^ (n >>> 7), 61 | n)) ^ n;
      return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
    };
  }
  const KEYS = [
    "editor.foreground",
    "sideBar.background",
    "sideBar.foreground",
    "descriptionForeground",
    "disabledForeground",
    "button.background",
    "button.foreground",
    "textLink.foreground",
    "editor.selectionBackground",
    "list.activeSelectionBackground",
    "list.activeSelectionForeground",
    "list.hoverBackground",
    "badge.background",
    "badge.foreground",
    "menu.background",
    "menu.selectionBackground",
    "notifications.background",
    "errorForeground",
    "charts.blue",
    "terminal.ansiCyan",
  ];

  test("every generated theme passes the contrast rules", () => {
    const next = random(28);
    const color = () =>
      `#${Math.floor(next() * 0xffffff)
        .toString(16)
        .padStart(6, "0")}${next() < 0.15 ? "80" : ""}`;
    const failures: string[] = [];
    for (let i = 0; i < 100; i++) {
      const colors: Record<string, string> = { "editor.background": color() };
      for (const key of KEYS) if (next() < 0.6) colors[key] = color();
      const problems = contrastFailures(buildThemeFromFile(parseVsCodeTheme({ colors })).tokens);
      if (problems.length) failures.push(`${JSON.stringify(colors)}: ${problems.join("; ")}`);
    }
    expect(failures).toEqual([]);
  }, 30_000); // ~2 s locally; CI runners are slower
});
