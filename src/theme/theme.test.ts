import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import indexHtml from "../../index.html?raw";
import tauriConf from "../../src-tauri/tauri.conf.json";
import { darkTheme, lightTheme, THEME_TOKENS } from "../styles/themes";
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
      `html[data-theme="light"] { background: ${lightTheme.tokens["--color-app-bg"]};`,
    );
    expect(criticalStyle).toContain(
      `html[data-theme="dark"] { background: ${darkTheme.tokens["--color-app-bg"]};`,
    );
  });

  test("the native window background matches the dark theme", () => {
    expect(tauriConf.app.windows[0].backgroundColor).toBe(darkTheme.tokens["--color-app-bg"]);
  });
});
