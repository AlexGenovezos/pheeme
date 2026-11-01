import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createRegistry, type CommandRegistry } from "../keyboard/registry";
import { useGlobalShortcuts } from "../keyboard/useCommands";
import { CommandPalette } from "./CommandPalette";
import { filterCommands, fuzzyMatch } from "./match";
import { usePaletteStore } from "./paletteStore";

let reg: CommandRegistry;
const toggleTheme = vi.fn();
const toggleSidebar = vi.fn();
const goInbox = vi.fn();

function Harness() {
  useGlobalShortcuts(reg);
  return (
    <>
      <button type="button">elsewhere</button>
      <CommandPalette registry={reg} />
    </>
  );
}

beforeEach(() => {
  usePaletteStore.setState({ open: false });
  reg = createRegistry({ isMac: false });
  reg.register({
    id: "palette.toggle",
    title: "Show all commands",
    shortcut: "mod+k",
    global: true,
    hidden: true,
    run: () => usePaletteStore.getState().toggle(),
  });
  reg.register({ id: "go.inbox", title: "Go to Inbox", group: "Navigation", shortcut: "g i", run: goInbox });
  reg.register({ id: "view.sidebar", title: "Toggle sidebar", group: "View", shortcut: "mod+b", run: toggleSidebar });
  reg.register({
    id: "theme.toggle",
    title: "Toggle light and dark theme",
    group: "Appearance",
    shortcut: "mod+shift+l",
    keywords: ["dark mode"],
    run: toggleTheme,
  });
});

const openWithKeyboard = () => fireEvent.keyDown(window, { key: "k", ctrlKey: true });
const options = () => within(screen.getByRole("listbox")).getAllByRole("option");

describe("CommandPalette", () => {
  test("Ctrl+K opens it with focus in the search field; hidden commands are left out", () => {
    render(<Harness />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    openWithKeyboard();
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveFocus();
    expect(options().map((o) => o.textContent)).not.toContain("Show all commands");
    expect(options()).toHaveLength(3);
  });

  test("each command shows its shortcut", () => {
    render(<Harness />);
    openWithKeyboard();
    const inbox = options().find((o) => o.textContent?.startsWith("Go to Inbox"))!;
    expect(within(inbox).getAllByText(/^[GI]$/).map((k) => k.textContent)).toEqual(["G", "I"]);
  });

  test("typing filters; keywords match too", () => {
    render(<Harness />);
    openWithKeyboard();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "sidebar" } });
    expect(options().map((o) => o.textContent)).toEqual([expect.stringContaining("Toggle sidebar")]);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "dark mode" } });
    expect(options()[0]).toHaveTextContent("Toggle light and dark theme");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "zzzz" } });
    expect(screen.getByText(/No commands match/)).toBeInTheDocument();
  });

  test("arrow keys move and Enter runs the active command, then closes", () => {
    render(<Harness />);
    openWithKeyboard();
    const input = screen.getByRole("combobox");
    expect(options()[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(options()[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(toggleSidebar).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("clicking a command runs it", () => {
    render(<Harness />);
    openWithKeyboard();
    fireEvent.click(options()[0]);
    expect(goInbox).toHaveBeenCalledTimes(1);
  });

  test("Escape closes and returns focus; Ctrl+K toggles it closed from the input", () => {
    render(<Harness />);
    const elsewhere = screen.getByRole("button", { name: "elsewhere" });
    elsewhere.focus();
    openWithKeyboard();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(elsewhere).toHaveFocus();

    openWithKeyboard();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "k", ctrlKey: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("tracks commands registered while open", () => {
    render(<Harness />);
    openWithKeyboard();
    act(() => void reg.register({ id: "late", title: "Late arrival", run: vi.fn() }));
    expect(options().map((o) => o.textContent)).toContain("Late arrival");
  });
});

describe("matching", () => {
  test("substring beats subsequence, word starts beat mid-word", () => {
    expect(fuzzyMatch("theme", "Toggle theme")!.score).toBeGreaterThan(fuzzyMatch("tgth", "Toggle theme")!.score);
    expect(fuzzyMatch("in", "Go to Inbox")!.indices).toEqual([6, 7]);
    expect(fuzzyMatch("xyz", "Go to Inbox")).toBeNull();
  });

  test("results are ranked", () => {
    const cmds = [
      { id: "a", title: "Mark as unread", run: vi.fn() },
      { id: "b", title: "Go to Inbox", run: vi.fn() },
    ];
    expect(filterCommands(cmds, "inbox").map((r) => r.command.id)).toEqual(["b"]);
    expect(filterCommands(cmds, "").map((r) => r.command.id)).toEqual(["a", "b"]);
  });
});
