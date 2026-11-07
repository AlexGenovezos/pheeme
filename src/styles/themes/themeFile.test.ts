import { describe, expect, test } from "vitest";
import { themeColorToHex } from "./color";
import { contrastFailures } from "./contrast";
import { darkTheme } from "./dark";
import {
  buildThemeFromFile,
  parseThemeFile,
  RESERVED_THEME_IDS,
  serializeThemeFile,
  themeIdFromName,
} from "./themeFile";

const minimal = { version: 1, name: "Harbour Night", kind: "dark", colors: { accent: "#5fb3d9" } };

describe("parseThemeFile", () => {
  test("fills in the id and stores colors as OKLCH", () => {
    const file = parseThemeFile(minimal);
    expect(file).toMatchObject({ id: "harbour-night", name: "Harbour Night", kind: "dark" });
    expect(file.colors.accent).toMatch(/^oklch\(/);
  });

  test.each([
    [null, /JSON object/],
    [{ ...minimal, version: 2 }, /version/],
    [{ ...minimal, name: " " }, /name/],
    [{ ...minimal, name: "x".repeat(49) }, /name/],
    [{ ...minimal, kind: "sepia" }, /kind/],
    [{ ...minimal, id: "Not An Id" }, /lowercase/],
    [{ ...minimal, colors: [] }, /colors/],
    [{ ...minimal, colors: { accent: "not-a-color" } }, /"accent" is not a color/],
    [{ ...minimal, colors: { "editor.background": "#000" } }, /at least one color/],
  ])("refuses %j", (value, message) => {
    expect(() => parseThemeFile(value)).toThrow(message);
  });

  test.each([...RESERVED_THEME_IDS])("refuses the reserved id %s", (id) => {
    expect(() => parseThemeFile({ ...minimal, id })).toThrow(/reserved/);
  });

  test("ignores colors it doesn't know, so newer files still load", () => {
    const file = parseThemeFile({ ...minimal, colors: { accent: "#fff", "future-token": "#000" } });
    expect(Object.keys(file.colors)).toEqual(["accent"]);
  });

  test("round-trips through serializeThemeFile", () => {
    const file = parseThemeFile(minimal);
    expect(parseThemeFile(JSON.parse(serializeThemeFile(file)))).toEqual(file);
  });
});

describe("themeIdFromName", () => {
  test.each([
    ["Harbour Night", "harbour-night"],
    ["  Solarized (light) ", "solarized-light"],
    ["!!!", "custom-theme"],
  ])("%s → %s", (name, id) => expect(themeIdFromName(name)).toBe(id));
});

describe("buildThemeFromFile", () => {
  test("colors left out come from the built-in theme of the same kind", () => {
    const t = buildThemeFromFile(parseThemeFile(minimal)).tokens;
    expect(t["--color-app-bg"]).toBe(darkTheme.tokens["--color-app-bg"]);
    expect(t["--shadow-popover"]).toBe(darkTheme.tokens["--shadow-popover"]);
  });

  test("hover colors are derived from the file's base colors, not the built-in's", () => {
    const t = buildThemeFromFile(parseThemeFile(minimal)).tokens;
    expect(themeColorToHex(t["--color-accent"])).toBe("#5fb3d9");
    expect(t["--color-accent-hover"]).not.toBe(darkTheme.tokens["--color-accent-hover"]);
    expect(t["--color-badge-accent-bg"]).toBe(t["--color-accent"]);
  });

  test("a file can override a derived color", () => {
    const file = parseThemeFile({ ...minimal, colors: { "accent-hover": "#ff0000" } });
    expect(themeColorToHex(buildThemeFromFile(file).tokens["--color-accent-hover"])).toBe(
      "#ff0000",
    );
  });

  test("a file holding a built-in theme's colors rebuilds it exactly", () => {
    const colors = Object.fromEntries(
      Object.entries(darkTheme.tokens)
        .filter(([token]) => token.startsWith("--color-"))
        .map(([token, value]) => [token.slice("--color-".length), value]),
    );
    const t = buildThemeFromFile(parseThemeFile({ ...minimal, colors })).tokens;
    expect(t).toEqual(darkTheme.tokens);
    expect(contrastFailures(t)).toEqual([]);
  });
});
