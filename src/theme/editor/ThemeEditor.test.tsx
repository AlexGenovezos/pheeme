import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useSettingsStore } from "../../settings/settingsStore";
import { darkTheme, lightTheme } from "../../styles/themes";
import { themeColorToHex } from "../../styles/themes/color";
import { initTheme, useThemeStore } from "../theme";
import { openThemeEditor, useThemeEditorStore } from "./editorStore";
import { hexToHsv, hsvToHex } from "./ColorPicker";
import { tokensAt } from "./inspector";
import { ThemeEditorHost } from "./ThemeEditor";

const root = document.documentElement;
const rootColor = (token: string) => themeColorToHex(root.style.getPropertyValue(token));
const panel = () => screen.getByRole("dialog", { name: /theme/i });
const hexInput = (label: string) =>
  within(panel()).getByRole("textbox", { name: `${label} hex value` });

let stop = () => {};
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  useThemeStore.setState({
    mode: "system",
    choices: { light: "pheeme-light", dark: "pheeme-dark" },
    customThemes: [],
    folderThemes: [],
  });
  useThemeEditorStore.setState({ open: false });
  useSettingsStore.setState({ open: false, page: "appearance" });
  stop = initTheme();
});
afterEach(() => {
  stop();
  vi.unstubAllGlobals();
});

describe("the theme editor", () => {
  test("simple mode builds the theme from a background and an accent, live, and Save keeps it", () => {
    render(<ThemeEditorHost />);
    act(() => openThemeEditor({ fromSettings: true }));
    expect(hexInput("Background")).toHaveValue(
      themeColorToHex(lightTheme.tokens["--color-app-bg"]),
    );

    fireEvent.change(hexInput("Background"), { target: { value: "#121314" } });
    fireEvent.change(hexInput("Accent"), { target: { value: "#2b91af" } });
    // Shown while editing, before anything is saved.
    expect(rootColor("--color-app-bg")).toBe("#121314");
    expect(useThemeStore.getState().customThemes).toEqual([]);

    fireEvent.change(within(panel()).getByRole("textbox", { name: "Name" }), {
      target: { value: "Night" },
    });
    fireEvent.click(within(panel()).getByRole("button", { name: "Save theme" }));

    expect(screen.queryByRole("dialog", { name: /theme/i })).toBeNull();
    const [saved] = useThemeStore.getState().customThemes;
    expect(saved).toMatchObject({
      id: "night",
      name: "Night",
      kind: "dark",
      seeds: { background: "#121314" },
    });
    // Made in Light mode, so it's chosen for Light mode, dark as it is.
    expect(useThemeStore.getState().choices.light).toBe("night");
    expect(rootColor("--color-app-bg")).toBe("#121314");
    expect(useSettingsStore.getState().open).toBe(true);
  });

  test("closing with changes asks first, and discarding puts the chosen theme back", () => {
    render(<ThemeEditorHost />);
    act(() => openThemeEditor({}));
    fireEvent.change(hexInput("Background"), { target: { value: "#121314" } });
    fireEvent.click(within(panel()).getByRole("button", { name: "Cancel" }));
    expect(within(panel()).getByText("Discard your changes?")).toBeTruthy();
    fireEvent.click(within(panel()).getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("dialog", { name: /theme/i })).toBeNull();
    expect(root.style.getPropertyValue("--color-app-bg")).toBe(lightTheme.tokens["--color-app-bg"]);
    expect(useThemeStore.getState().customThemes).toEqual([]);
  });

  test("every-color mode sets one color, and the colors derived from it follow", () => {
    render(<ThemeEditorHost />);
    act(() => openThemeEditor({ id: "pheeme-dark", slot: "dark" }));
    expect(useThemeEditorStore.getState().draft.name).toBe("Pheeme Dark copy");
    fireEvent.click(within(panel()).getByRole("switch", { name: "Edit every color" }));
    fireEvent.change(within(panel()).getByRole("textbox", { name: "Filter colors" }), {
      target: { value: "accent" },
    });
    expect(within(panel()).queryByText("App background")).toBeNull();
    fireEvent.change(hexInput("Accent"), { target: { value: "#e0457b" } });
    expect(rootColor("--color-accent")).toBe("#e0457b");
    expect(root.style.getPropertyValue("--color-accent-hover")).not.toBe(
      darkTheme.tokens["--color-accent-hover"],
    );
  });

  test("a custom theme is edited in place", () => {
    render(<ThemeEditorHost />);
    act(() => openThemeEditor({}));
    fireEvent.change(hexInput("Background"), { target: { value: "#fdf6e3" } });
    fireEvent.click(within(panel()).getByRole("button", { name: "Save theme" }));
    const [{ id }] = useThemeStore.getState().customThemes;

    act(() => openThemeEditor({ id, slot: "light" }));
    fireEvent.change(hexInput("Background"), { target: { value: "#fbf1d8" } });
    fireEvent.click(within(panel()).getByRole("button", { name: "Save" }));
    expect(useThemeStore.getState().customThemes).toHaveLength(1);
    expect(useThemeStore.getState().customThemes[0].id).toBe(id);
    expect(rootColor("--color-app-bg")).toBe("#fbf1d8");
  });
});

describe("the color picker", () => {
  test.each(["#000000", "#ffffff", "#2b91af", "#e0457b", "#808080"])("%s survives HSV", (hex) => {
    expect(hsvToHex(hexToHsv(hex))).toBe(hex);
  });
});

describe("the inspector", () => {
  test("finds the theme colors an element paints", () => {
    const el = document.createElement("div");
    el.style.backgroundColor = themeColorToHex(darkTheme.tokens["--color-sidebar-bg"]);
    el.style.color = themeColorToHex(darkTheme.tokens["--color-sidebar-foreground"]);
    document.body.append(el);
    expect(tokensAt(el, darkTheme.tokens)).toEqual(
      expect.arrayContaining(["--color-sidebar-bg", "--color-sidebar-foreground"]),
    );
    el.remove();
  });
});
