import { beforeEach, describe, expect, test } from "vitest";
import {
  findConflicts,
  KEYBINDINGS_KEY,
  loadBindings,
  readBindings,
  resetAllBindings,
  resetBinding,
  sameShortcut,
  setBinding,
  setBindings,
  stepFromEvent,
} from "./bindings";
import { createRegistry, type CommandRegistry } from "./registry";

const key = (k: string, init: Partial<KeyboardEvent> = {}) => ({
  key: k,
  code: "",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...init,
});

let reg: CommandRegistry;
beforeEach(() => {
  localStorage.clear();
  reg = createRegistry({ isMac: false });
  reg.register({ id: "archive", title: "Archive", shortcut: "e", run: () => {} });
  reg.register({ id: "inbox", title: "Go to Inbox", shortcut: "g i", run: () => {} });
  reg.register({ id: "star", title: "Star", run: () => {} });
});

describe("stepFromEvent", () => {
  test("Ctrl is mod off macOS, Cmd is mod on macOS", () => {
    expect(stepFromEvent(key("k", { ctrlKey: true }), false)).toBe("mod+k");
    expect(stepFromEvent(key("k", { metaKey: true }), true)).toBe("mod+k");
    expect(stepFromEvent(key("k", { ctrlKey: true }), true)).toBe("ctrl+k");
  });

  test("Shift is kept for letters and dropped for symbols it produced", () => {
    expect(stepFromEvent(key("U", { shiftKey: true }), false)).toBe("shift+u");
    expect(stepFromEvent(key("#", { shiftKey: true }), false)).toBe("#");
    expect(stepFromEvent(key("L", { ctrlKey: true, shiftKey: true }), false)).toBe("mod+shift+l");
  });

  test("lone modifiers record nothing; Space and Option+letter record by name", () => {
    expect(stepFromEvent(key("Shift", { shiftKey: true }), false)).toBeNull();
    expect(stepFromEvent(key(" "), false)).toBe("space");
    expect(stepFromEvent(key("å", { altKey: true, code: "KeyA" }), true)).toBe("alt+a");
  });
});

test("sameShortcut compares meaning, not spelling", () => {
  expect(sameShortcut("Mod+Shift+L", "mod+shift+l")).toBe(true);
  expect(sameShortcut("esc", "escape")).toBe(true);
  expect(sameShortcut(null, null)).toBe(true);
  expect(sameShortcut("e", null)).toBe(false);
});

test("conflicts include the same keys and chord prefixes either way", () => {
  const titles = (s: string) => findConflicts(s, reg.list(), "star").map((c) => c.title);
  expect(titles("e")).toEqual(["Archive"]);
  expect(titles("g")).toEqual(["Go to Inbox"]);
  expect(titles("g i")).toEqual(["Go to Inbox"]);
  expect(titles("g a")).toEqual([]);
  expect(findConflicts("e", reg.list(), "archive")).toEqual([]);
});

describe("storing bindings", () => {
  test("only differences from the default are stored, and they survive a reload", () => {
    setBinding("archive", "y", reg);
    setBinding("star", "s", reg);
    expect(JSON.parse(localStorage.getItem(KEYBINDINGS_KEY)!)).toEqual({ archive: "y", star: "s" });
    setBinding("archive", "e", reg);
    expect(reg.overrides()).toEqual({ star: "s" });

    const fresh = createRegistry({ isMac: false });
    loadBindings(fresh);
    fresh.register({ id: "star", title: "Star", run: () => {} });
    expect(fresh.get("star")?.shortcut).toBe("s");
  });

  test("swapping takes the keys from one command and gives them to another", () => {
    setBindings({ star: "e", archive: null }, reg);
    expect(reg.get("star")?.shortcut).toBe("e");
    expect(reg.get("archive")?.shortcut).toBeUndefined();
    resetBinding("archive", reg);
    expect(reg.get("archive")?.shortcut).toBe("e");
    resetAllBindings(reg);
    expect(reg.overrides()).toEqual({});
    expect(JSON.parse(localStorage.getItem(KEYBINDINGS_KEY)!)).toEqual({});
  });

  test("junk in storage is ignored", () => {
    localStorage.setItem(
      KEYBINDINGS_KEY,
      JSON.stringify({ a: "mod+shift", b: 3, c: null, d: "x" }),
    );
    expect(readBindings()).toEqual({ c: null, d: "x" });
    localStorage.setItem(KEYBINDINGS_KEY, "not json");
    expect(readBindings()).toEqual({});
  });
});
