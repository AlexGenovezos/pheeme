import { describe, expect, test } from "vitest";
import { parseThemeText } from "../../theme/customThemes";
import { parseFolderFiles } from "../../theme/themeFolder";
import { themeColorToHex } from "./color";
import { contrastFailures } from "./contrast";
import { isT3Theme, themeFromSeeds } from "./t3";
import { buildThemeFromFile } from "./themeFile";

const hex = (value: string) => themeColorToHex(value);
const tokensOf = (file: Parameters<typeof buildThemeFromFile>[0]) =>
  buildThemeFromFile(file).tokens;

/** A T3 Code theme with both halves, the "light" one dark too (as T3 allows). */
const twoHalves = {
  version: 1,
  name: "Old and New",
  appearance: "dark",
  colors: {
    canvas: "#121314",
    sidebar: "#191a1b",
    text: "#bfbfbf",
    textMuted: "#8c8c8c",
    border: "#2a2b2c",
    accent: "#2b91af",
    accentForeground: "#ffffff",
    sidebarRowActive: "#1e3840",
    surfaceOverlay: "#202122",
  },
  variants: {
    light: { canvas: "#1e1e1e", sidebar: "#252526", text: "#cccccc", accent: "#2b91af" },
  },
};

describe("T3 Code theme files", () => {
  test("are told apart from Pheeme theme files", () => {
    expect(isT3Theme(twoHalves)).toBe(true);
    expect(isT3Theme({ version: 1, name: "P", kind: "dark", colors: {} })).toBe(false);
  });

  test("a file with both halves gives a theme for each mode", () => {
    const themes = parseThemeText(JSON.stringify(twoHalves), "old-and-new.json");
    expect(themes.map((t) => [t.file.name, t.slot, t.file.kind])).toEqual([
      ["Old and New · Dark", "dark", "dark"],
      // Meant for Light mode, but dark: Pheeme draws it as a dark theme.
      ["Old and New · Light", "light", "dark"],
    ]);
  });

  test("keeps T3's colors where they are readable, and makes every text color readable", () => {
    const [dark, light] = parseThemeText(JSON.stringify(twoHalves));
    const t = tokensOf(dark.file);
    expect(hex(t["--color-app-bg"])).toBe("#121314");
    expect(hex(t["--color-sidebar-bg"])).toBe("#191a1b");
    expect(hex(t["--color-accent"])).toBe("#2b91af");
    expect(hex(t["--color-menu-bg"])).toBe("#202122");
    expect(contrastFailures(t)).toEqual([]);
    expect(hex(tokensOf(light.file)["--color-app-bg"])).toBe("#1e1e1e");
    expect(contrastFailures(tokensOf(light.file))).toEqual([]);
  });

  test("a file with only its two starting colors is built from them, and stays editable from them", () => {
    const [{ file }] = parseThemeText(
      JSON.stringify({
        version: 1,
        name: "Seeded",
        appearance: "light",
        canvas: "#fbf7f0",
        accent: "#b4532a",
        colors: {},
      }),
    );
    expect(file.kind).toBe("light");
    expect(file.seeds).toEqual({ background: "#fbf7f0", accent: "#b4532a" });
    expect(hex(tokensOf(file)["--color-app-bg"])).toBe("#fbf7f0");
  });

  test("a file without a background says so", () => {
    expect(() =>
      parseThemeText(
        JSON.stringify({ version: 1, name: "Empty", appearance: "dark", colors: { text: "#fff" } }),
      ),
    ).toThrow(/no "canvas" color/);
  });
});

describe("themes from two colors", () => {
  test.each([
    ["#121314", "#2b91af", "dark"],
    ["#ffffff", "#0b57d0", "light"],
    ["#fdf6e3", "#cb4b16", "light"],
    ["#180f1b", "#a84370", "dark"],
    ["#000000", "#ffd400", "dark"],
    ["#808080", "#808080", "light"],
  ] as const)("%s with %s is a readable %s theme", (background, accent, kind) => {
    const file = themeFromSeeds("Seeded", { background, accent });
    expect(file.kind).toBe(kind);
    const t = tokensOf(file);
    expect(hex(t["--color-app-bg"])).toBe(background);
    expect(contrastFailures(t)).toEqual([]);
  });
});

describe("the themes folder", () => {
  test("loads every theme it can, and says which files it couldn't", () => {
    const { themes, failures } = parseFolderFiles([
      { name: "old-and-new.json", text: JSON.stringify(twoHalves) },
      { name: "broken.json", text: "{ nope" },
      {
        name: "harbour.json",
        text: JSON.stringify({
          version: 1,
          name: "Harbour",
          kind: "dark",
          colors: { "app-bg": "#10161c" },
        }),
      },
    ]);
    expect(themes.map((t) => t.id)).toEqual(["old-and-new-dark", "old-and-new-light", "harbour"]);
    expect(failures).toEqual([
      expect.stringMatching(/^broken\.json: broken\.json isn't valid JSON/),
    ]);
  });
});
