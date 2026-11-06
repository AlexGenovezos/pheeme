import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import indexHtml from "../../index.html?raw";
import tauriConf from "../../src-tauri/tauri.conf.json";
import tauriMacConf from "../../src-tauri/tauri.macos.conf.json";
import { darkTheme, lightTheme, THEME_TOKENS } from "../styles/themes";
import {
  contrastRatio,
  themeColorToHex,
  toCanonicalThemeColor,
  withAlpha,
} from "../styles/themes/color";
import { initTheme, readThemeMode, resolveTheme, THEME_MODE_KEY, useThemeStore } from "./theme";

/** A controllable prefers-color-scheme media query. */
function mockSystemDark(initial: boolean) {
  let matches = initial;
  const listeners = new Set<() => void>();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return matches;
      },
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    })),
  );
  return (next: boolean) => {
    matches = next;
    listeners.forEach((l) => l());
  };
}

const root = document.documentElement;

beforeEach(() => {
  localStorage.clear();
  root.removeAttribute("style");
  root.removeAttribute("data-theme");
});
afterEach(() => vi.unstubAllGlobals());

describe("resolveTheme", () => {
  test("system follows the OS", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
  test("explicit modes ignore the OS", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("persistence", () => {
  test("defaults to system when nothing or garbage is stored", () => {
    expect(readThemeMode()).toBe("system");
    localStorage.setItem(THEME_MODE_KEY, "sepia");
    expect(readThemeMode()).toBe("system");
  });

  test("setMode persists and applies the theme tokens to :root", () => {
    mockSystemDark(false);
    const stop = initTheme();
    useThemeStore.getState().setMode("dark");
    expect(localStorage.getItem(THEME_MODE_KEY)).toBe("dark");
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
    expect(root.style.getPropertyValue("--color-app-bg")).toBe(darkTheme.tokens["--color-app-bg"]);
    stop();
  });

  test("writes hex where the webview can't parse oklch()", () => {
    mockSystemDark(false);
    vi.stubGlobal("CSS", { supports: (_: string, value: string) => !value.startsWith("oklch(") });
    const stop = initTheme();
    expect(root.style.getPropertyValue("--color-app-bg")).toBe("#ffffff");
    expect(root.style.getPropertyValue("--color-sidebar-vibrant-bg")).toBe("#f2f4f466");
    stop();
  });

  test("initTheme restores the stored mode", () => {
    mockSystemDark(true);
    localStorage.setItem(THEME_MODE_KEY, "light");
    const stop = initTheme();
    expect(useThemeStore.getState()).toMatchObject({ mode: "light", resolved: "light" });
    expect(root.dataset.theme).toBe("light");
    stop();
  });

  test("toggle flips from what is showing and stores an explicit mode", () => {
    mockSystemDark(true);
    const stop = initTheme();
    expect(useThemeStore.getState().resolved).toBe("dark");
    useThemeStore.getState().toggle();
    expect(useThemeStore.getState()).toMatchObject({ mode: "light", resolved: "light" });
    expect(localStorage.getItem(THEME_MODE_KEY)).toBe("light");
    stop();
  });
});

describe("live system changes", () => {
  test("System mode follows prefers-color-scheme as it changes", () => {
    const setDark = mockSystemDark(false);
    const onChange = vi.fn();
    const stop = initTheme(onChange);
    expect(root.dataset.theme).toBe("light");
    setDark(true);
    expect(root.dataset.theme).toBe("dark");
    expect(onChange).toHaveBeenLastCalledWith("system", darkTheme);
    stop();
  });

  test("an explicit mode ignores OS changes", () => {
    const setDark = mockSystemDark(false);
    localStorage.setItem(THEME_MODE_KEY, "light");
    const stop = initTheme();
    setDark(true);
    expect(root.dataset.theme).toBe("light");
    stop();
  });
});

describe("theme files", () => {
  test("light and dark define every schema token", () => {
    const schema = Object.keys(THEME_TOKENS).sort();
    expect(Object.keys(lightTheme.tokens).sort()).toEqual(schema);
    expect(Object.keys(darkTheme.tokens).sort()).toEqual(schema);
  });

  test.each([lightTheme, darkTheme])("$name stores every color as canonical OKLCH", (theme) => {
    for (const [token, value] of Object.entries(theme.tokens)) {
      if (token.startsWith("--shadow-")) continue;
      expect(value, token).toMatch(/^oklch\([\d.]+ [\d.]+ [\d.]+( \/ [\d.]+)?\)$/);
      expect(toCanonicalThemeColor(value), token).toBe(value);
    }
  });

  type Token = keyof typeof lightTheme.tokens;
  // Every text color on each surface it is drawn on: WCAG AA, 4.5:1. Translucent surfaces sit on the pane.
  const TEXT: [Token, Token[]][] = [
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
    ...(["--color-foreground-muted", "--color-foreground-subtle"] as const).map(
      (muted): [Token, Token[]] => [
        muted,
        [
          "--color-pane-bg",
          "--color-sidebar-bg",
          "--color-badge-bg",
          "--color-list-active-bg",
          "--color-list-hover-bg",
          "--color-list-inactive-bg",
          "--color-menu-bg",
        ],
      ],
    ),
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
    ["--color-avatar-foreground", [1, 2, 3, 4, 5, 6].map((i) => `--color-avatar-${i}` as Token)],
  ];
  // Indicators that aren't text: 3:1 (WCAG non-text contrast).
  const NON_TEXT: [Token, Token[]][] = [
    ["--color-focus-border", ["--color-pane-bg"]],
    ["--color-unread-indicator", ["--color-pane-bg", "--color-list-active-bg"]],
    ...[1, 2, 3, 4, 5, 6].map((i): [Token, Token[]] => [
      `--color-account-${i}` as Token,
      ["--color-sidebar-bg"],
    ]),
  ];

  test.each([lightTheme, darkTheme])("$name keeps every foreground readable", (theme) => {
    const t = theme.tokens;
    const failures = [
      ...TEXT.map((p) => [...p, 4.5] as const),
      ...NON_TEXT.map((p) => [...p, 3] as const),
    ]
      .flatMap(([fg, bgs, min]) =>
        bgs.map((bg) => ({
          pair: `${fg} on ${bg}`,
          ratio: contrastRatio(t[fg], t[bg], t["--color-pane-bg"]),
          min,
        })),
      )
      .filter(({ ratio, min }) => ratio < min)
      .map(({ pair, ratio }) => `${pair}: ${ratio.toFixed(2)}`);
    expect(failures).toEqual([]);
  });

  test.each([lightTheme, darkTheme])(
    "$name keeps disabled controls dimmer than enabled secondary text",
    (theme) => {
      const t = theme.tokens;
      const onPane = (token: Token) => contrastRatio(t[token], t["--color-pane-bg"]);
      expect(onPane("--color-foreground-muted")).toBeGreaterThanOrEqual(
        onPane("--color-foreground-subtle"),
      );
      expect(onPane("--color-foreground-subtle")).toBeGreaterThan(
        onPane("--color-foreground-disabled"),
      );
    },
  );

  test.each([lightTheme, darkTheme])(
    "$name mailbox colors read as text on the sidebar, selected or not",
    (theme) => {
      const t = theme.tokens;
      // --sidebar-selected-tint in tokens.css (vitest doesn't load CSS, so it is repeated here).
      const tint = 0.12;
      const tokens = Object.keys(THEME_TOKENS).filter((k): k is Token =>
        k.startsWith("--color-mailbox-"),
      );
      expect(tokens).toHaveLength(11);
      for (const token of tokens) {
        const selected = withAlpha(t[token], tint);
        expect(contrastRatio(t[token], t["--color-sidebar-bg"]), token).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(t[token], selected, t["--color-sidebar-bg"]),
          `${token} selected`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );
});

describe("no white flash", () => {
  const bootScript = indexHtml.match(/<script>([\s\S]*?)<\/script>/)![1];
  // Whitespace-collapsed, so the check survives the formatter reflowing the rules.
  const criticalStyle = indexHtml.match(/<style>([\s\S]*?)<\/style>/)![1].replace(/\s+/g, " ");

  test.each(["light", "dark"] as const)(
    "boot script applies a stored %s choice before React",
    (mode) => {
      localStorage.setItem(THEME_MODE_KEY, mode);
      new Function(bootScript)();
      expect(root.getAttribute("data-theme")).toBe(mode);
    },
  );

  test("boot script leaves System to the media query", () => {
    localStorage.setItem(THEME_MODE_KEY, "system");
    new Function(bootScript)();
    expect(root.hasAttribute("data-theme")).toBe(false);
  });

  test("critical style colors match each theme's app background", () => {
    expect(criticalStyle).toContain(
      `html[data-theme="light"] { background: ${themeColorToHex(lightTheme.tokens["--color-app-bg"])};`,
    );
    expect(criticalStyle).toContain(
      `html[data-theme="dark"] { background: ${themeColorToHex(darkTheme.tokens["--color-app-bg"])};`,
    );
  });

  test("the native window background matches the dark theme", () => {
    expect(tauriConf.app.windows[0].backgroundColor).toBe(
      themeColorToHex(darkTheme.tokens["--color-app-bg"]),
    );
  });

  test("the macOS window is the main window made transparent over sidebar vibrancy", () => {
    // Platform config replaces the windows array whole, so the two copies must not drift.
    const main: Record<string, unknown> = { ...tauriConf.app.windows[0] };
    delete main.backgroundColor; // opaque would cover the vibrancy
    expect(tauriMacConf.app.windows).toEqual([
      {
        ...main,
        transparent: true,
        windowEffects: { effects: ["sidebar"], state: "followsWindowActiveState" },
      },
    ]);
  });

  test("the window stays hidden until the frontend has painted", () => {
    expect(tauriConf.app.windows[0].visible).toBe(false);
  });
});
