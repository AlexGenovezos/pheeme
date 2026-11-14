import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import indexHtml from "../../index.html?raw";
import tauriConf from "../../src-tauri/tauri.conf.json";
import tauriMacConf from "../../src-tauri/tauri.macos.conf.json";
import { darkTheme, lightTheme, THEME_TOKENS } from "../styles/themes";
import { themeColorToHex, toCanonicalThemeColor } from "../styles/themes/color";
import { contrastFailures, MAILBOX_TOKENS } from "../styles/themes/contrast";
import { serializeThemeFile, type ThemeFile } from "../styles/themes/themeFile";
import { CUSTOM_THEMES_KEY, parseThemeText } from "./customThemes";
import {
  definitionOf,
  initTheme,
  inkSidebarTheme,
  previewTheme,
  readSidebarStyle,
  readThemeMode,
  resolveTheme,
  SIDEBAR_STYLE_KEY,
  sidebarSurfaceCss,
  TINTED_SIDEBAR_BG,
  tintedSidebarTokens,
  THEME_BOOT_KEY,
  THEME_CHOICE_KEYS,
  THEME_MODE_KEY,
  themeOptions,
  useThemeStore,
} from "./theme";

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

describe("custom themes", () => {
  const harbour = parseThemeText(
    JSON.stringify({ version: 1, name: "Harbour", kind: "dark", colors: { "app-bg": "#10161c" } }),
  )[0].file;
  const paper = parseThemeText(
    JSON.stringify({ version: 1, name: "Paper", kind: "light", colors: { "app-bg": "#fdf6e3" } }),
  )[0].file;
  /** Installed for the mode of its own kind, as an import does. */
  const own = (...files: ThemeFile[]) => files.map((file) => ({ file, slot: file.kind }));
  const appBg = () => themeColorToHex(root.style.getPropertyValue("--color-app-bg"));

  beforeEach(() =>
    useThemeStore.setState({
      mode: "system",
      choices: { light: "pheeme-light", dark: "pheeme-dark" },
      customThemes: [],
      folderThemes: [],
    }),
  );

  test("installing a theme saves it, picks it for its kind and shows it", () => {
    mockSystemDark(false);
    const onChange = vi.fn();
    const stop = initTheme(onChange);
    useThemeStore.getState().installThemes(own(harbour));
    expect(useThemeStore.getState()).toMatchObject({ mode: "dark", resolved: "dark" });
    expect(appBg()).toBe("#10161c");
    expect(onChange).toHaveBeenLastCalledWith("dark", expect.objectContaining({ id: "harbour" }));
    expect(JSON.parse(localStorage.getItem(CUSTOM_THEMES_KEY)!)).toEqual([harbour]);
    expect(localStorage.getItem(THEME_CHOICE_KEYS.dark)).toBe("harbour");
    expect(JSON.parse(localStorage.getItem(THEME_BOOT_KEY)!)).toEqual({
      light: "#ffffff",
      dark: "#10161c",
    });
    stop();
  });

  test("importing a light and a dark theme together picks both", () => {
    mockSystemDark(false);
    const stop = initTheme();
    useThemeStore.getState().installThemes(own(paper, harbour));
    expect(useThemeStore.getState().choices).toEqual({ light: "paper", dark: "harbour" });
    expect(useThemeStore.getState().mode).toBe("dark");
    useThemeStore.getState().setMode("light");
    expect(appBg()).toBe("#fdf6e3");
    stop();
  });

  test("two files with the same id in one import install once, the later winning", () => {
    mockSystemDark(true);
    const stop = initTheme();
    const later = { ...harbour, name: "Harbour 2" };
    useThemeStore.getState().installThemes(own(harbour, later));
    expect(useThemeStore.getState().customThemes).toEqual([later]);
    stop();
  });

  test("a theme for the kind already showing keeps the mode", () => {
    mockSystemDark(false);
    const stop = initTheme();
    useThemeStore.getState().installThemes(own(paper));
    expect(useThemeStore.getState().mode).toBe("system");
    expect(appBg()).toBe("#fdf6e3");
    stop();
  });

  test("installed themes and choices come back on the next launch", () => {
    mockSystemDark(true);
    localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify([harbour, paper]));
    localStorage.setItem(THEME_CHOICE_KEYS.dark, "harbour");
    const stop = initTheme();
    expect(useThemeStore.getState().customThemes).toEqual([harbour, paper]);
    expect(appBg()).toBe("#10161c");
    expect(themeOptions("dark", useThemeStore.getState().customThemes)).toEqual([
      { id: "pheeme-dark", name: "Pheeme Dark", kind: "dark", source: "built-in" },
      { id: "pheeme-light", name: "Pheeme Light", kind: "light", source: "built-in" },
      { id: "harbour", name: "Harbour", kind: "dark", source: "custom" },
      { id: "paper", name: "Paper", kind: "light", source: "custom" },
    ]);
    stop();
  });

  test("a stored theme that no longer validates is skipped, and a missing choice falls back", () => {
    mockSystemDark(true);
    const broken = { ...harbour, id: "dark" } as ThemeFile;
    localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify([broken, paper]));
    localStorage.setItem(THEME_CHOICE_KEYS.dark, "dark");
    const stop = initTheme();
    expect(useThemeStore.getState().customThemes).toEqual([paper]);
    expect(root.style.getPropertyValue("--color-app-bg")).toBe(darkTheme.tokens["--color-app-bg"]);
    stop();
  });

  test("re-importing a theme replaces it rather than adding a second", () => {
    mockSystemDark(true);
    const stop = initTheme();
    useThemeStore.getState().installThemes(own(harbour));
    const updated = { ...harbour, colors: { "app-bg": "oklch(0.3 0 0)" } };
    useThemeStore.getState().installThemes(own(updated));
    expect(useThemeStore.getState().customThemes).toEqual([updated]);
    expect(root.style.getPropertyValue("--color-app-bg")).toBe("oklch(0.3 0 0)");
    stop();
  });

  test("removing the theme in use goes back to the built-in theme", () => {
    mockSystemDark(true);
    const stop = initTheme();
    useThemeStore.getState().installThemes(own(harbour));
    useThemeStore.getState().removeTheme("harbour");
    expect(useThemeStore.getState().customThemes).toEqual([]);
    expect(useThemeStore.getState().choices.dark).toBe("pheeme-dark");
    expect(localStorage.getItem(THEME_CHOICE_KEYS.dark)).toBe("pheeme-dark");
    expect(root.style.getPropertyValue("--color-app-bg")).toBe(darkTheme.tokens["--color-app-bg"]);
    stop();
  });

  test("choosing a theme for the other kind doesn't change what's showing", () => {
    mockSystemDark(false);
    const stop = initTheme();
    useThemeStore.setState({ customThemes: [harbour] });
    useThemeStore.getState().chooseTheme("dark", "harbour");
    expect(appBg()).toBe("#ffffff");
    useThemeStore.getState().toggle();
    expect(appBg()).toBe("#10161c");
    stop();
  });

  test("a theme that can't be saved isn't installed", () => {
    mockSystemDark(false);
    const stop = initTheme();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(() => useThemeStore.getState().installThemes(own(harbour))).toThrow(/storage is full/);
    expect(useThemeStore.getState().customThemes).toEqual([]);
    vi.restoreAllMocks();
    stop();
  });

  test("any theme fits either mode: a dark theme chosen for Light mode shows as dark", () => {
    mockSystemDark(false);
    const stop = initTheme();
    useThemeStore.getState().installThemes([{ file: harbour, slot: "light" }]);
    expect(useThemeStore.getState()).toMatchObject({ mode: "system", resolved: "light" });
    expect(useThemeStore.getState().choices.light).toBe("harbour");
    expect(appBg()).toBe("#10161c");
    expect(root.dataset.theme).toBe("dark");
    stop();
  });

  test("the built-in dark theme can be chosen for Light mode", () => {
    mockSystemDark(false);
    const stop = initTheme();
    useThemeStore.getState().chooseTheme("light", "pheeme-dark");
    expect(root.style.getPropertyValue("--color-app-bg")).toBe(darkTheme.tokens["--color-app-bg"]);
    stop();
  });

  test("themes-folder themes can be chosen, are cached for the next launch, and lose to an installed copy", () => {
    mockSystemDark(true);
    const stop = initTheme();
    useThemeStore.getState().setFolderThemes([harbour]);
    useThemeStore.getState().chooseTheme("dark", "harbour");
    expect(appBg()).toBe("#10161c");
    expect(themeOptions("dark", [], [harbour])[2]).toMatchObject({
      id: "harbour",
      source: "folder",
    });
    stop();

    const relaunch = initTheme();
    expect(useThemeStore.getState().folderThemes).toEqual([harbour]);
    expect(appBg()).toBe("#10161c");
    const edited = { ...harbour, colors: { "app-bg": "#202830" } };
    useThemeStore.getState().installThemes(own(edited));
    expect(appBg()).toBe("#202830");
    // Removing the installed copy falls back to the folder's, not the built-in theme.
    useThemeStore.getState().removeTheme("harbour");
    expect(useThemeStore.getState().choices.dark).toBe("harbour");
    expect(appBg()).toBe("#10161c");
    relaunch();
  });

  test("a preview shows over the chosen theme until it is cleared, and survives a mode change", () => {
    mockSystemDark(false);
    const stop = initTheme();
    previewTheme(definitionOf(harbour));
    expect(appBg()).toBe("#10161c");
    useThemeStore.getState().setMode("dark");
    expect(appBg()).toBe("#10161c");
    previewTheme(null);
    expect(root.style.getPropertyValue("--color-app-bg")).toBe(darkTheme.tokens["--color-app-bg"]);
    stop();
  });

  test("serialized files load back as the same theme", () => {
    expect(parseThemeText(serializeThemeFile(harbour))[0].file).toEqual(harbour);
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

  test.each([lightTheme, darkTheme])(
    "$name keeps every foreground readable (contrast.ts)",
    (theme) => {
      expect(MAILBOX_TOKENS).toHaveLength(11);
      expect(contrastFailures(theme.tokens)).toEqual([]);
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

  test("boot script paints the chosen custom theme's background", () => {
    localStorage.setItem(THEME_MODE_KEY, "dark");
    localStorage.setItem(THEME_BOOT_KEY, JSON.stringify({ light: "#ffffff", dark: "#10161c" }));
    new Function(bootScript)();
    expect(root.style.getPropertyValue("--color-app-bg")).toBe("#10161c");
  });

  test("boot script follows the OS for System, and ignores a malformed color", () => {
    mockSystemDark(false);
    localStorage.setItem(THEME_BOOT_KEY, JSON.stringify({ light: "#fdf6e3", dark: "#10161c" }));
    new Function(bootScript)();
    expect(root.style.getPropertyValue("--color-app-bg")).toBe("#fdf6e3");
    root.removeAttribute("style");
    localStorage.setItem(THEME_BOOT_KEY, JSON.stringify({ light: "red; color: blue" }));
    new Function(bootScript)();
    expect(root.style.getPropertyValue("--color-app-bg")).toBe("");
  });

  test("critical style colors match each theme's app background", () => {
    expect(criticalStyle).toContain(
      `html[data-theme="light"] { background: var(--color-app-bg, ${themeColorToHex(lightTheme.tokens["--color-app-bg"])});`,
    );
    expect(criticalStyle).toContain(
      `html[data-theme="dark"] { background: var(--color-app-bg, ${themeColorToHex(darkTheme.tokens["--color-app-bg"])});`,
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

describe("sidebarSurfaceCss", () => {
  test("Light, the default, leaves Pheeme Light's own sidebar (and macOS vibrancy) alone", () => {
    expect(readSidebarStyle()).toBe("light");
    expect(sidebarSurfaceCss(lightTheme, "light")).toBe("");
  });

  test("Dark: Pheeme Light's sidebar wears Pheeme Dark's colours, solid", () => {
    const css = sidebarSurfaceCss(lightTheme, "dark");
    expect(css).toContain(`--color-sidebar-surface:${darkTheme.tokens["--color-sidebar-bg"]}`);
    expect(css).toContain(`.shell__sidebar{`);
    expect(css).toContain(`--color-foreground:${darkTheme.tokens["--color-foreground"]}`);
    expect(css).toContain("color-scheme:dark");
    expect(css).toContain("--color-pane-border:transparent");
  });

  test("Ink: a whole deep-blue palette, every color readable on it", () => {
    const ink = inkSidebarTheme().tokens;
    expect(ink["--color-sidebar-bg"]).not.toBe(darkTheme.tokens["--color-sidebar-bg"]);
    expect(contrastFailures(ink)).toEqual([]);
    const css = sidebarSurfaceCss(lightTheme, "ink");
    expect(css).toContain(`--color-sidebar-surface:${ink["--color-sidebar-bg"]}`);
    expect(css).toContain("color-scheme:dark");
  });

  test("Tinted: Pheeme Light on a blue wash, changing only what must change to stay readable", () => {
    const bg = toCanonicalThemeColor(TINTED_SIDEBAR_BG)!;
    const tinted = tintedSidebarTokens();
    expect(tinted["--color-sidebar-bg"]).toBe(bg);
    expect(tinted["--color-foreground"]).toBeUndefined();
    expect(contrastFailures({ ...lightTheme.tokens, ...tinted })).toEqual([]);
    const css = sidebarSurfaceCss(lightTheme, "tinted");
    expect(css).toContain(`:root{--color-sidebar-surface:${bg}}`);
    expect(css).toContain(`--color-sidebar-vibrant-bg:${bg}`);
    expect(css).not.toContain("color-scheme:dark");
  });

  test("without oklch support the colours are hex", () => {
    for (const style of ["tinted", "ink", "dark"] as const) {
      const css = sidebarSurfaceCss(lightTheme, style, false);
      expect(css).not.toMatch(/oklch\(/);
      expect(css).toMatch(/--color-sidebar-surface:#[0-9a-f]{6}/i);
    }
  });

  test("every other theme keeps its own sidebar", () => {
    for (const style of ["light", "tinted", "ink", "dark"] as const)
      expect(sidebarSurfaceCss(darkTheme, style)).toBe("");
  });

  test("the choice is remembered, and an unknown value falls back to Light", () => {
    useThemeStore.getState().setSidebarStyle("ink");
    expect(localStorage.getItem(SIDEBAR_STYLE_KEY)).toBe("ink");
    expect(readSidebarStyle()).toBe("ink");
    localStorage.setItem(SIDEBAR_STYLE_KEY, "purple");
    expect(readSidebarStyle()).toBe("light");
  });
});
