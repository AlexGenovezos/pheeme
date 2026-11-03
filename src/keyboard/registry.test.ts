import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { describeShortcut, formatShortcut } from "./format";
import { createRegistry, isEditableTarget, parseShortcut, type CommandRegistry } from "./registry";

function press(key: string, init: KeyboardEventInit & { target?: EventTarget } = {}) {
  const { target = document.body, ...rest } = init;
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...rest });
  Object.defineProperty(e, "target", { value: target });
  return e;
}

let reg: CommandRegistry;
beforeEach(() => {
  vi.useFakeTimers();
  reg = createRegistry({ isMac: false, chordTimeoutMs: 1000 });
});
afterEach(() => vi.useRealTimers());

describe("single keys", () => {
  test("runs the bound command and prevents the default", () => {
    const run = vi.fn();
    reg.register({ id: "archive", title: "Archive", shortcut: "e", run });
    const e = press("e");
    expect(reg.handleKeyDown(e)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  test("letters respect Shift; symbols don't need it spelled out", () => {
    const upper = vi.fn();
    const hash = vi.fn();
    reg.register({ id: "u", title: "Unread", shortcut: "shift+u", run: upper });
    reg.register({ id: "del", title: "Delete", shortcut: "#", run: hash });
    expect(reg.handleKeyDown(press("u"))).toBe(false);
    reg.handleKeyDown(press("U", { shiftKey: true }));
    reg.handleKeyDown(press("#", { shiftKey: true }));
    expect(upper).toHaveBeenCalledTimes(1);
    expect(hash).toHaveBeenCalledTimes(1);
  });

  test("mod is Ctrl off macOS and Cmd on macOS", () => {
    const run = vi.fn();
    reg.register({ id: "p", title: "Palette", shortcut: "mod+k", run });
    reg.handleKeyDown(press("k", { metaKey: true }));
    expect(run).not.toHaveBeenCalled();
    reg.handleKeyDown(press("k", { ctrlKey: true }));
    expect(run).toHaveBeenCalledTimes(1);

    const mac = createRegistry({ isMac: true });
    const macRun = vi.fn();
    mac.register({ id: "p", title: "Palette", shortcut: "mod+k", run: macRun });
    mac.handleKeyDown(press("k", { ctrlKey: true }));
    mac.handleKeyDown(press("k", { metaKey: true }));
    expect(macRun).toHaveBeenCalledTimes(1);
  });

  test("an unmodified binding doesn't fire for a modified key", () => {
    const run = vi.fn();
    reg.register({ id: "e", title: "Archive", shortcut: "e", run });
    reg.handleKeyDown(press("e", { ctrlKey: true }));
    expect(run).not.toHaveBeenCalled();
  });
});

describe("g chords", () => {
  test("g then i runs go-to-inbox and shows the pending prefix in between", () => {
    const inbox = vi.fn();
    reg.register({ id: "go.inbox", title: "Go to Inbox", shortcut: "g i", run: inbox });
    reg.register({ id: "go.sent", title: "Go to Sent", shortcut: "g t", run: vi.fn() });
    expect(reg.handleKeyDown(press("g"))).toBe(true);
    expect(reg.pendingChord()).toBe("g");
    expect(reg.completions().map((c) => c.command.id)).toEqual(["go.inbox", "go.sent"]);
    reg.handleKeyDown(press("i"));
    expect(inbox).toHaveBeenCalledTimes(1);
    expect(reg.pendingChord()).toBeNull();
  });

  test("the chord expires after the timeout", () => {
    const inbox = vi.fn();
    reg.register({ id: "go.inbox", title: "Go to Inbox", shortcut: "g i", run: inbox });
    reg.handleKeyDown(press("g"));
    vi.advanceTimersByTime(1001);
    expect(reg.pendingChord()).toBeNull();
    reg.handleKeyDown(press("i"));
    expect(inbox).not.toHaveBeenCalled();
  });

  test("a key that isn't part of the chord cancels it and is handled on its own", () => {
    const inbox = vi.fn();
    const archive = vi.fn();
    reg.register({ id: "go.inbox", title: "Go to Inbox", shortcut: "g i", run: inbox });
    reg.register({ id: "archive", title: "Archive", shortcut: "e", run: archive });
    reg.handleKeyDown(press("g"));
    reg.handleKeyDown(press("e"));
    expect(archive).toHaveBeenCalledTimes(1);
    reg.handleKeyDown(press("i"));
    expect(inbox).not.toHaveBeenCalled();
  });
});

describe("text fields", () => {
  test.each([
    ["input", () => document.createElement("input")],
    ["textarea", () => document.createElement("textarea")],
    [
      "contenteditable",
      () => {
        const host = document.createElement("div");
        host.setAttribute("contenteditable", "true");
        const child = document.createElement("span");
        host.append(child);
        return child;
      },
    ],
    [
      "button inside a region that owns its keys (compose)",
      () => {
        const host = document.createElement("section");
        host.setAttribute("data-owns-keys", "");
        const child = document.createElement("button");
        host.append(child);
        return child;
      },
    ],
  ])("single keys and chords are ignored in a %s", (_, make) => {
    const target = make();
    const archive = vi.fn();
    const inbox = vi.fn();
    reg.register({ id: "archive", title: "Archive", shortcut: "e", run: archive });
    reg.register({ id: "go.inbox", title: "Go to Inbox", shortcut: "g i", run: inbox });
    expect(reg.handleKeyDown(press("e", { target }))).toBe(false);
    expect(reg.handleKeyDown(press("g", { target }))).toBe(false);
    reg.handleKeyDown(press("i", { target }));
    expect(archive).not.toHaveBeenCalled();
    expect(inbox).not.toHaveBeenCalled();
    expect(reg.pendingChord()).toBeNull();
  });

  test("global commands still fire in a text field", () => {
    const run = vi.fn();
    reg.register({ id: "p", title: "Palette", shortcut: "mod+k", global: true, run });
    reg.handleKeyDown(press("k", { ctrlKey: true, target: document.createElement("input") }));
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("checkboxes are not text fields", () => {
    const box = document.createElement("input");
    box.type = "checkbox";
    expect(isEditableTarget(box)).toBe(false);
  });
});

describe("registration", () => {
  test("list reflects register/unregister and notifies subscribers", () => {
    const listener = vi.fn();
    reg.subscribe(listener);
    const off = reg.register({ id: "a", title: "A", run: vi.fn() });
    expect(reg.list().map((c) => c.id)).toEqual(["a"]);
    off();
    expect(reg.list()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test("a stale unregister doesn't remove a newer registration with the same id", () => {
    const first = reg.register({ id: "a", title: "A1", run: vi.fn() });
    reg.register({ id: "a", title: "A2", run: vi.fn() });
    first();
    expect(reg.get("a")?.title).toBe("A2");
  });

  test("rejects malformed shortcuts", () => {
    expect(() => parseShortcut("shift")).toThrow();
  });
});

describe("formatting", () => {
  test("macOS uses symbols, others use words", () => {
    expect(formatShortcut("mod+shift+l", "macos")).toEqual([["⇧", "⌘", "L"]]);
    expect(formatShortcut("mod+shift+l", "windows")).toEqual([["Ctrl", "Shift", "L"]]);
  });
  test("chords become one cap group per step", () => {
    expect(formatShortcut("g i", "linux")).toEqual([["G"], ["I"]]);
    expect(describeShortcut("g i", "linux")).toBe("G then I");
    expect(describeShortcut("mod+k", "linux")).toBe("Ctrl+K");
  });
});

describe("user bindings", () => {
  test("an override replaces the default for matching, listing and labels", () => {
    const run = vi.fn();
    reg.register({ id: "archive", title: "Archive", shortcut: "e", run });
    reg.setOverrides({ archive: "y" });
    expect(reg.handleKeyDown(press("e"))).toBe(false);
    expect(reg.handleKeyDown(press("y"))).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(reg.list()[0].shortcut).toBe("y");
    expect(reg.get("archive")?.shortcut).toBe("y");
    expect(reg.defaultShortcut("archive")).toBe("e");
    expect(reg.shortcutFor("archive")).toBe("y");
  });

  test("null removes the shortcut; overrides apply to commands registered later", () => {
    const run = vi.fn();
    reg.setOverrides({ archive: null, star: "mod+shift+s" });
    reg.register({ id: "archive", title: "Archive", shortcut: "e", run });
    reg.register({ id: "star", title: "Star", shortcut: "s", run });
    expect(reg.handleKeyDown(press("e"))).toBe(false);
    expect(reg.shortcutFor("archive", "e")).toBeUndefined();
    expect(reg.handleKeyDown(press("S", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(reg.shortcutFor("unregistered", "v")).toBe("v");
  });

  test("a stored binding that doesn't parse falls back to the default", () => {
    const run = vi.fn();
    reg.setOverrides({ archive: "mod+shift" });
    reg.register({ id: "archive", title: "Archive", shortcut: "e", run });
    expect(reg.handleKeyDown(press("e"))).toBe(true);
  });

  test("suspend stops all shortcuts until resumed", () => {
    const run = vi.fn();
    reg.register({ id: "palette", title: "Palette", shortcut: "mod+k", global: true, run });
    const resume = reg.suspend();
    expect(reg.handleKeyDown(press("k", { ctrlKey: true }))).toBe(false);
    resume();
    resume(); // idempotent
    expect(reg.handleKeyDown(press("k", { ctrlKey: true }))).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

test("a global command rebound to a plain key doesn't fire while typing", () => {
  const run = vi.fn();
  reg.register({ id: "settings", title: "Settings", shortcut: "mod+,", global: true, run });
  reg.setOverrides({ settings: "q" });
  const input = document.createElement("input");
  expect(reg.handleKeyDown(press("q", { target: input }))).toBe(false);
  expect(reg.handleKeyDown(press("q"))).toBe(true);
  expect(run).toHaveBeenCalledTimes(1);
});
