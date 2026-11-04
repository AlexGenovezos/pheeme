import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { version } from "../../package.json";
import { displayVersion } from "../lib/updater";
import { ReleaseNotes } from "./ReleaseNotes";
import { releasesFrom } from "./releaseNotes";
import { Settings } from "./Settings";
import { useSettingsStore } from "./settingsStore";

const openExternal = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../lib/tauri", async (orig) => ({
  ...(await orig<typeof import("../lib/tauri")>()),
  openExternal,
}));

test("Settings › About lists the bundled notes, marking the running version", () => {
  render(<Settings />);
  act(() => useSettingsStore.getState().openSettings("about"));
  const notes = screen.getByRole("region", { name: "What's new" });
  const current = within(notes).getByRole("article", {
    name: `Version ${displayVersion(version)}`,
  });
  expect(within(current).getByText("This version")).toBeInTheDocument();
});

test("renders headings, bullets and code, and opens links in the browser", () => {
  const notes = [
    "Compose is here.",
    "",
    "**Sending**",
    "- `Cmd/Ctrl+Enter` sends. See [the guide](https://pheeme.app/guide).",
  ].join("\n");
  render(
    <ReleaseNotes
      releases={releasesFrom({ "x/v0.9.md": notes, "x/v0.8.md": "Older.\n" }, "0.9.0")}
      current="0.9.0"
    />,
  );
  const [v09, v08] = screen.getAllByRole("article");
  expect(v09).toHaveAccessibleName("Version 0.9");
  expect(within(v09).getByText("This version")).toBeInTheDocument();
  expect(within(v08).queryByText("This version")).not.toBeInTheDocument();
  expect(within(v09).getByRole("heading", { name: "Sending" })).toBeInTheDocument();
  expect(within(v09).getByText("Cmd/Ctrl+Enter").tagName).toBe("CODE");

  fireEvent.click(within(v09).getByRole("link", { name: "the guide" }));
  expect(openExternal).toHaveBeenCalledWith("https://pheeme.app/guide");
});
