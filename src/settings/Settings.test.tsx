import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { KEYBINDINGS_KEY } from "../keyboard/bindings";
import { registry } from "../keyboard/registry";
import { useGlobalShortcuts } from "../keyboard/useCommands";
import { useAccountStore } from "../store/accountStore";
import { __resetUiStoreForTests, useUiStore } from "../store/uiStore";
import { useThemeStore } from "../theme/theme";
import { SEQUENCE_WAIT_MS } from "./KeyboardSettings";
import { Settings } from "./Settings";
import { useSettingsStore } from "./settingsStore";
import { initReadingSize, READING_SIZE_KEY } from "./readingSettings";

const archive = vi.fn();
const star = vi.fn();

function Harness() {
  useGlobalShortcuts();
  return (
    <>
      <button type="button">behind</button>
      <Settings />
    </>
  );
}

const dialog = () => screen.getByRole("dialog", { name: /Settings/ });
const open = (page?: string) => act(() => useSettingsStore.getState().openSettings(page));

beforeEach(() => {
  localStorage.clear();
  initReadingSize();
  registry.clear();
  __resetUiStoreForTests();
  useSettingsStore.setState({ open: false, page: "appearance" });
  useAccountStore.setState({
    accounts: [
      { id: "a1", email: "me@example.com", displayName: "Me", clientId: "c", synced: true },
    ],
    syncErrors: {},
    reconnecting: null,
  });
  archive.mockReset();
  star.mockReset();
  registry.register({
    id: "conversation.archive",
    title: "Archive",
    group: "Conversation",
    shortcut: "e",
    run: archive,
  });
  registry.register({
    id: "conversation.star",
    title: "Star or unstar",
    group: "Conversation",
    shortcut: "s",
    run: star,
  });
  registry.register({
    id: "go.inbox",
    title: "Go to Inbox",
    group: "Navigation",
    shortcut: "g i",
    run: () => {},
  });
});

afterEach(() => vi.useRealTimers());

test("opens on the chosen page, and Escape or the close button closes it", () => {
  render(<Harness />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  open("accounts");
  expect(within(dialog()).getByRole("heading", { name: /Accounts/ })).toBeInTheDocument();
  expect(within(dialog()).getByText("me@example.com")).toBeInTheDocument();

  fireEvent.keyDown(dialog(), { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  open();
  fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
  expect(useSettingsStore.getState().open).toBe(false);
});

test("app shortcuts don't fire while the dialog is open", () => {
  render(<Harness />);
  open();
  fireEvent.keyDown(dialog(), { key: "e" });
  expect(archive).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
  fireEvent.keyDown(window, { key: "e" });
  expect(archive).toHaveBeenCalledTimes(1);
});

test("Appearance sets the theme mode and the sidebar", () => {
  render(<Harness />);
  open("appearance");
  fireEvent.click(within(dialog()).getByRole("radio", { name: "Dark" }));
  expect(useThemeStore.getState().mode).toBe("dark");
  expect(within(dialog()).getByRole("radio", { name: "Dark" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  fireEvent.keyDown(within(dialog()).getByRole("radio", { name: "Dark" }), { key: "ArrowLeft" });
  expect(useThemeStore.getState().mode).toBe("light");

  fireEvent.click(within(dialog()).getByRole("switch", { name: "Show sidebar" }));
  expect(useUiStore.getState().sidebarCollapsed).toBe(true);
});

test("Appearance changes and persists the reading size", () => {
  render(<Harness />);
  open("appearance");
  fireEvent.click(within(dialog()).getByRole("radio", { name: "Large" }));
  expect(document.documentElement.dataset.readingSize).toBe("large");
  expect(localStorage.getItem(READING_SIZE_KEY)).toBe("large");
  expect(within(dialog()).getByRole("radio", { name: "Large" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

describe("search", () => {
  test("narrows pages and rows, and finds keyboard commands", () => {
    render(<Harness />);
    open();
    const search = screen.getByRole("searchbox", { name: "Search settings" });
    const nav = within(screen.getByRole("navigation", { name: "Settings sections" }));

    fireEvent.change(search, { target: { value: "dark mode" } });
    expect(nav.getAllByRole("button").map((b) => b.textContent)).toEqual(["Appearance"]);
    expect(within(dialog()).getByText("Mode", { selector: ".settings-row__title" })).toBeVisible();
    expect(within(dialog()).queryByText("Show sidebar")).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "archive" } });
    expect(nav.getAllByRole("button").map((b) => b.textContent)).toEqual(["Keyboard shortcuts"]);
    expect(within(dialog()).getByRole("searchbox", { name: "Filter shortcuts" })).toHaveValue(
      "archive",
    );
    expect(within(dialog()).queryByText("Go to Inbox")).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "zzz" } });
    expect(within(dialog()).getByText(/No settings match/)).toBeInTheDocument();
    // Escape clears the search before it closes the dialog.
    fireEvent.keyDown(search, { key: "Escape" });
    expect(search).toHaveValue("");
    expect(useSettingsStore.getState().open).toBe(true);
  });

  test("finds Send diagnostics on its own page", () => {
    render(<Harness />);
    open();
    const search = screen.getByRole("searchbox", { name: "Search settings" });
    const nav = within(screen.getByRole("navigation", { name: "Settings sections" }));
    fireEvent.change(search, { target: { value: "diagnostics" } });
    expect(nav.getAllByRole("button").map((b) => b.textContent)).toEqual(["Diagnostics"]);
    expect(
      within(dialog()).getByText("Send diagnostics", { selector: ".settings-row__title" }),
    ).toBeVisible();
  });

  test("/ focuses the search", () => {
    render(<Harness />);
    open();
    fireEvent.keyDown(dialog(), { key: "/" });
    expect(screen.getByRole("searchbox", { name: "Search settings" })).toHaveFocus();
  });
});

describe("keyboard shortcuts", () => {
  const recorder = (title: string) =>
    within(dialog()).getByRole("button", {
      name: new RegExp(`^(Change shortcut|Add a shortcut|Recording a shortcut) for ${title}`),
    });

  test("records a new shortcut, which the app then answers to and remembers", () => {
    render(<Harness />);
    open("keyboard");
    fireEvent.click(recorder("Archive"));
    expect(recorder("Archive")).toHaveFocus();
    fireEvent.keyDown(recorder("Archive"), { key: "y", ctrlKey: true });
    expect(registry.get("conversation.archive")?.shortcut).toBe("mod+y");
    expect(JSON.parse(localStorage.getItem(KEYBINDINGS_KEY)!)).toEqual({
      "conversation.archive": "mod+y",
    });

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    fireEvent.keyDown(window, { key: "e" });
    fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    expect(archive).toHaveBeenCalledTimes(1);
  });

  test("a plain key waits for a second one, so sequences can be recorded", () => {
    vi.useFakeTimers();
    render(<Harness />);
    open("keyboard");
    fireEvent.click(recorder("Star or unstar"));
    fireEvent.keyDown(recorder("Star or unstar"), { key: "x" });
    fireEvent.keyDown(recorder("Star or unstar"), { key: "s" });
    expect(registry.get("conversation.star")?.shortcut).toBe("x s");

    fireEvent.click(recorder("Star or unstar"));
    fireEvent.keyDown(recorder("Star or unstar"), { key: "z" });
    expect(registry.get("conversation.star")?.shortcut).toBe("x s");
    act(() => vi.advanceTimersByTime(SEQUENCE_WAIT_MS));
    expect(registry.get("conversation.star")?.shortcut).toBe("z");
  });

  test("Escape cancels recording without closing the dialog", () => {
    render(<Harness />);
    open("keyboard");
    fireEvent.click(recorder("Archive"));
    fireEvent.keyDown(recorder("Archive"), { key: "Escape" });
    expect(useSettingsStore.getState().open).toBe(true);
    expect(registry.get("conversation.archive")?.shortcut).toBe("e");
    expect(recorder("Archive")).toHaveAccessibleName(/currently E/);
  });

  test("a clash asks before taking the keys from the other command", () => {
    render(<Harness />);
    open("keyboard");
    fireEvent.click(recorder("Star or unstar"));
    fireEvent.keyDown(recorder("Star or unstar"), { key: "g" });
    fireEvent.keyDown(recorder("Star or unstar"), { key: "i" });
    const alert = within(dialog()).getByRole("alert");
    expect(alert).toHaveTextContent("G then I is used by “Go to Inbox”");
    expect(registry.get("conversation.star")?.shortcut).toBe("s");

    fireEvent.click(within(alert).getByRole("button", { name: "Replace" }));
    expect(registry.get("conversation.star")?.shortcut).toBe("g i");
    expect(registry.get("go.inbox")?.shortcut).toBeUndefined();
    expect(within(dialog()).getByRole("button", { name: "Add a shortcut for Go to Inbox" }));
  });

  test("resetting to a default another command took since asks first", () => {
    render(<Harness />);
    open("keyboard");
    // Star took "e" from Archive.
    act(() => registry.setOverrides({ "conversation.archive": null, "conversation.star": "e" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Reset Archive to E" }));
    expect(within(dialog()).getByRole("alert")).toHaveTextContent("E is used by “Star or unstar”");
    expect(registry.get("conversation.archive")?.shortcut).toBeUndefined();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Replace" }));
    expect(registry.get("conversation.archive")?.shortcut).toBe("e");
    expect(registry.get("conversation.star")?.shortcut).toBeUndefined();
  });

  test("clicking a key on the keyboard map narrows the list to its command", () => {
    render(<Harness />);
    open("keyboard");
    fireEvent.click(within(dialog()).getByRole("button", { name: "E: Archive" }));
    expect(within(dialog()).getByText("Showing E")).toBeInTheDocument();
    expect(recorder("Archive")).toBeInTheDocument();
    expect(
      within(dialog()).queryByRole("button", { name: /shortcut for Star or unstar/ }),
    ).toBeNull();

    fireEvent.click(within(dialog()).getByRole("button", { name: "Show all" }));
    expect(recorder("Star or unstar")).toBeInTheDocument();
  });

  test("reset puts one shortcut back; Reset all puts them all back", () => {
    render(<Harness />);
    open("keyboard");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Remove shortcut for Archive" }));
    expect(registry.get("conversation.archive")?.shortcut).toBeUndefined();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Reset Archive to E" }));
    expect(registry.get("conversation.archive")?.shortcut).toBe("e");

    const resetAll = within(dialog()).getByRole("button", { name: "Reset all shortcuts" });
    expect(resetAll).toBeDisabled();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Remove shortcut for Archive" }));
    fireEvent.click(
      within(dialog()).getByRole("button", { name: "Remove shortcut for Star or unstar" }),
    );
    fireEvent.click(resetAll);
    expect(registry.overrides()).toEqual({});
  });
});

test("Accounts offers to sign in again only when Google signed the account out", () => {
  render(<Harness />);
  open("accounts");
  expect(within(dialog()).queryByRole("button", { name: "Sign in again" })).toBeNull();
  act(() =>
    useAccountStore.setState({
      syncErrors: { a1: { code: "signed_out", message: "Google signed Pheeme out" } },
    }),
  );
  fireEvent.click(within(dialog()).getByRole("button", { name: "Sign in again" }));
  expect(useAccountStore.getState().reconnecting).toBe("a1");
  expect(useSettingsStore.getState().open).toBe(false);
});

test("Accounts can remove an account after confirming", async () => {
  const remove = vi.fn().mockResolvedValue(undefined);
  useAccountStore.setState({ remove });
  render(<Harness />);
  open("accounts");
  fireEvent.click(within(dialog()).getByRole("button", { name: "Remove" }));
  expect(within(dialog()).getByText(/Nothing changes in Gmail/)).toBeInTheDocument();
  fireEvent.click(within(dialog()).getByRole("button", { name: "Remove" }));
  expect(remove).toHaveBeenCalledWith("a1");
});

test("Reading exposes the exact image-preloading privacy description", () => {
  render(<Harness />);
  open("appearance");
  expect(screen.getByRole("switch", { name: "Preload images" })).toBeChecked();
  expect(
    screen.getByText(
      "Preloading images lets senders see that an email was opened, along with your IP address and approximate location, even for emails you skip. Turning it off keeps text preloading, and loads images only when you open an email.",
    ),
  ).toBeInTheDocument();
});
