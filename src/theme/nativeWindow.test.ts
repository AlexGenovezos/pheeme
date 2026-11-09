import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { darkTheme, lightTheme } from "../styles/themes";

const setTheme = vi.fn<(theme: string | null) => Promise<void>>(() => Promise.resolve());
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setTheme, setBackgroundColor: () => Promise.resolve() }),
}));
vi.mock("../lib/platform", () => ({ platform: "macos" }));
vi.mock("../preview/runtime", () => ({ isTauri: () => true }));

const { syncNativeWindow } = await import("./nativeWindow");

const root = document.documentElement;
let osDark = true;

beforeEach(() => {
  setTheme.mockClear();
  root.dataset.vibrancy = "";
  vi.stubGlobal("matchMedia", () => ({ matches: osDark }));
});
afterEach(() => vi.unstubAllGlobals());

describe("the native window", () => {
  test("in System mode the OS keeps the appearance, even under a theme of the other kind", () => {
    // Overriding it would flip prefers-color-scheme, re-resolve the theme, and flicker forever.
    osDark = true;
    syncNativeWindow("system", lightTheme);
    expect(setTheme).toHaveBeenLastCalledWith(null);
  });

  test("a theme of the other kind covers the vibrancy, which would show the OS appearance", () => {
    osDark = true;
    syncNativeWindow("system", lightTheme);
    expect(root.dataset.vibrancy).toBeUndefined();
    syncNativeWindow("system", darkTheme);
    expect(root.dataset.vibrancy).toBe("");
  });

  test("a chosen mode sets the appearance to the theme's kind, so vibrancy matches", () => {
    osDark = true;
    syncNativeWindow("light", lightTheme);
    expect(setTheme).toHaveBeenLastCalledWith("light");
    expect(root.dataset.vibrancy).toBe("");
  });
});
