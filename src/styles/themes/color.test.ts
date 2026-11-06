import { describe, expect, test } from "vitest";
import { lightTheme } from ".";
import { buildTheme, DERIVED_TOKENS, type ThemeSource } from "./build";
import {
  contrastRatio,
  emphasize,
  readableThemeColorOn,
  scaleAlpha,
  themeColorToHex,
  toCanonicalThemeColor,
  withAlpha,
} from "./color";

describe("toCanonicalThemeColor", () => {
  test("writes any CSS color as OKLCH and keeps its alpha", () => {
    expect(toCanonicalThemeColor("#ffffff")).toBe("oklch(1 0 0)");
    expect(toCanonicalThemeColor("rgb(0 0 0 / 50%)")).toBe("oklch(0 0 0 / 0.5)");
    expect(toCanonicalThemeColor(" #1d6f69 ")).toMatch(/^oklch\(0\.4\d+ 0\.0\d+ 18\d\.\d+\)$/);
  });

  test("maps colors outside sRGB into it", () => {
    const vivid = toCanonicalThemeColor("oklch(0.7 0.4 150)")!;
    const [, chroma] = vivid.match(/^oklch\([\d.]+ ([\d.]+)/)!;
    expect(Number(chroma)).toBeLessThan(0.4);
    expect(toCanonicalThemeColor(vivid)).toBe(vivid);
  });

  test("rejects values that aren't colors", () => {
    expect(toCanonicalThemeColor("var(--x)")).toBeNull();
    expect(toCanonicalThemeColor("red; background: url(x)")).toBeNull();
    expect(toCanonicalThemeColor("")).toBeNull();
  });

  test("round-trips to the same 8-bit hex", () => {
    for (const hex of ["#1d6f69", "#f2f4f4", "#15191a", "#0e141429", "#e3c050"]) {
      expect(themeColorToHex(toCanonicalThemeColor(hex)!)).toBe(hex);
    }
  });
});

describe("contrastRatio", () => {
  test("matches WCAG for opaque colors", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  test("composites a translucent surface over its base first", () => {
    // #00000080 is 128/255 black: over white that is #7f7f7f.
    expect(contrastRatio("#ffffff", "#00000080", "#ffffff")).toBeCloseTo(
      contrastRatio("#ffffff", "#7f7f7f"),
      2,
    );
    // A translucent foreground is composited over that surface too.
    expect(contrastRatio("#00000000", "#ffffff")).toBeCloseTo(1);
  });
});

describe("readableThemeColorOn", () => {
  test("leaves a color that already passes alone", () => {
    expect(readableThemeColorOn("#1a1f1f", "#ffffff", 4.5)).toBe("#1a1f1f");
  });

  test.each([
    ["dark text on a dark surface", "#b42318", "#1f2525"],
    ["light text on a light surface", "#86c8f5", "#ffffff"],
  ])("moves lightness only until %s reaches the target", (_, color, surface) => {
    const fixed = readableThemeColorOn(color, surface, 4.5);
    expect(contrastRatio(fixed, surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(fixed, surface)).toBeLessThan(4.7);
    const hue = (c: string) => Number(toCanonicalThemeColor(c)!.match(/ ([\d.]+)\)$/)![1]);
    expect(hue(fixed)).toBeCloseTo(hue(color), 0);
  });
});

describe("variants", () => {
  test("emphasize steps away from the background", () => {
    const l = (c: string) => Number(c.match(/^oklch\(([\d.]+)/)![1]);
    expect(l(emphasize("#1d6f69", "light", 0.05))).toBeCloseTo(
      l(toCanonicalThemeColor("#1d6f69")!) - 0.05,
    );
    expect(l(emphasize("#4cc2b7", "dark", 0.05))).toBeCloseTo(
      l(toCanonicalThemeColor("#4cc2b7")!) + 0.05,
    );
  });

  test("alpha helpers set or scale opacity", () => {
    expect(themeColorToHex(withAlpha("#f2f4f4", 0.4))).toBe("#f2f4f466");
    expect(themeColorToHex(scaleAlpha("#ffffff0f", 2))).toBe("#ffffff1e");
  });
});

describe("buildTheme", () => {
  const { id, name, kind } = lightTheme;
  const tokens: Record<string, string> = { ...lightTheme.tokens };
  for (const token of DERIVED_TOKENS) delete tokens[token];
  const base = { id, name, kind, tokens } as ThemeSource;

  test("derives variant tokens from their base colors", () => {
    const built = buildTheme({ ...base, tokens: { ...base.tokens, "--color-accent": "#aa3300" } });
    expect(built.tokens["--color-badge-accent-bg"]).toBe(toCanonicalThemeColor("#aa3300"));
    expect(built.tokens["--color-accent-hover"]).toBe(emphasize("#aa3300", "light", 0.05));
  });

  test("a theme can override a derived token", () => {
    const built = buildTheme({
      ...base,
      tokens: { ...base.tokens, "--color-accent-hover": "#123456" },
    });
    expect(themeColorToHex(built.tokens["--color-accent-hover"])).toBe("#123456");
  });

  test("rejects a token that isn't a color", () => {
    expect(() =>
      buildTheme({ ...base, tokens: { ...base.tokens, "--color-link": "blurple" } }),
    ).toThrow(/--color-link is not a color/);
  });
});
