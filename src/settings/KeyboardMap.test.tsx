import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { Command } from "../keyboard/registry";
import { KeyboardMap } from "./KeyboardMap";

const cmd = (id: string, title: string, shortcut: string, group = "Mail"): Command => ({
  id,
  title,
  group,
  shortcut,
  run() {},
});

const commands = [
  cmd("archive", "Archive", "e"),
  cmd("previous", "Previous conversation", "k", "Navigation"),
  cmd("palette", "Show all commands", "mod+k", "General"),
  cmd("delete", "Delete", "#"),
  cmd("inbox", "Go to Inbox", "g i", "Navigation"),
  cmd("sent", "Go to Sent", "g t", "Navigation"),
];

const setup = (onPick = vi.fn()) => {
  render(<KeyboardMap commands={commands} onPick={onPick} platform="macos" />);
  return onPick;
};
const key = (name: string | RegExp) => screen.getByRole("button", { name });
const layer = () => screen.getByRole("group").getAttribute("aria-label");

test("draws the plain layer: used keys are buttons, free keys are not", () => {
  setup();
  expect(layer()).toBe("Keyboard map, No modifier");
  expect(key("E: Archive")).toBeInTheDocument();
  expect(key("K: Previous conversation")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Q:/ })).toBeNull();
  expect(screen.getByRole("radio", { name: "No modifier 2" })).toBeChecked();
});

test("hovering a key says what it does", () => {
  setup();
  fireEvent.mouseEnter(key("E: Archive"));
  expect(document.querySelector(".kbmap__tip")).toHaveTextContent("Archive");
  fireEvent.mouseLeave(screen.getByRole("group"));
  expect(document.querySelector(".kbmap__tip")).toBeNull();
});

test("a modifier key or chip switches layers, and the held key switches back", () => {
  setup();
  fireEvent.mouseEnter(screen.getAllByRole("button", { name: "⌘: show ⌘ shortcuts" })[0]);
  expect(document.querySelector(".kbmap__tip")).toHaveTextContent("1 ⌘ shortcut");
  fireEvent.click(screen.getAllByRole("button", { name: "⌘: show ⌘ shortcuts" })[0]);
  expect(layer()).toBe("Keyboard map, ⌘");
  expect(key("K: Show all commands")).toBeInTheDocument();

  fireEvent.click(screen.getAllByRole("button", { name: "⌘: back" })[0]);
  expect(layer()).toBe("Keyboard map, No modifier");

  fireEvent.click(screen.getByRole("radio", { name: "⇧ 1" }));
  expect(key("3: Delete")).toBeInTheDocument();
});

test("holding a modifier shows its layer until it's let go", () => {
  setup();
  fireEvent.keyDown(window, { key: "Meta", metaKey: true });
  expect(layer()).toBe("Keyboard map, ⌘");
  fireEvent.keyUp(window, { key: "Meta" });
  expect(layer()).toBe("Keyboard map, No modifier");
  // A combination nothing uses leaves the map alone.
  fireEvent.keyDown(window, { key: "Alt", altKey: true });
  expect(layer()).toBe("Keyboard map, No modifier");
});

test("the key that starts a sequence lists the sequence and opens it", () => {
  setup();
  fireEvent.mouseEnter(key("G: show G then… shortcuts"));
  const tip = document.querySelector(".kbmap__tip")!;
  expect(tip).toHaveTextContent("Starts 2 sequences");
  expect(tip).toHaveTextContent("Go to Inbox");
  fireEvent.click(key("G: show G then… shortcuts"));
  expect(layer()).toBe("Keyboard map, G then…");
  expect(key("I: Go to Inbox")).toBeInTheDocument();
  fireEvent.click(key("G: back"));
  expect(layer()).toBe("Keyboard map, No modifier");
});

test("clicking a used key picks its commands", () => {
  const onPick = setup();
  fireEvent.click(key("E: Archive"));
  expect(onPick).toHaveBeenCalledWith([commands[0]]);
});
