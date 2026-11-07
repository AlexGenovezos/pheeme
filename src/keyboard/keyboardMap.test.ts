import { describe, expect, test } from "vitest";
import { boardRows, buildKeyboardMap, capLabel, layerIdFor, layerSize } from "./keyboardMap";
import type { Command } from "./registry";

const cmd = (id: string, shortcut?: string, group = "Mail"): Command => ({
  id,
  title: id,
  group,
  shortcut,
  run() {},
});

const titles = (list?: Command[]) => list?.map((c) => c.title);

describe("buildKeyboardMap", () => {
  const commands = [
    cmd("archive", "e"),
    cmd("palette", "mod+k"),
    cmd("previous", "k"),
    cmd("delete", "#"),
    cmd("unread", "shift+u"),
    cmd("theme", "mod+shift+l"),
    cmd("inbox", "g i"),
    cmd("sent", "g t"),
    cmd("unbound"),
  ];

  test("sorts shortcuts into layers by modifiers, then sequences", () => {
    const layers = buildKeyboardMap(commands, "macos");
    expect(layers.map((l) => [l.label, layerSize(l)])).toEqual([
      ["No modifier", 2],
      ["⇧", 2],
      ["⌘", 1],
      ["⇧⌘", 1],
      ["G then…", 2],
    ]);
    expect(titles(layers[0].bindings.get("k"))).toEqual(["previous"]);
    expect(titles(layers[2].bindings.get("k"))).toEqual(["palette"]);
  });

  test("puts shifted symbols on the key that types them", () => {
    const shift = buildKeyboardMap(commands, "macos").find((l) => l.id === layerIdFor(["shift"]))!;
    expect(titles(shift.bindings.get("3"))).toEqual(["delete"]);
    expect(titles(shift.bindings.get("u"))).toEqual(["unread"]);
  });

  test("resolves mod to Ctrl off macOS", () => {
    const labels = buildKeyboardMap(commands, "windows").map((l) => l.label);
    expect(labels).toEqual(["No modifier", "Ctrl", "Shift", "Ctrl+Shift", "G then…"]);
  });

  test("the key that starts a sequence opens that sequence's layer", () => {
    const [plain, , , , g] = buildKeyboardMap(commands, "macos");
    expect(plain.prefixes.get("g")).toBe(g.id);
    expect(g.parent).toBe(plain.id);
    expect(titles(g.bindings.get("i"))).toEqual(["inbox"]);
  });

  test("keeps every command bound to the same key, and the plain layer when nothing is bound", () => {
    const clash = buildKeyboardMap([cmd("a", "escape"), cmd("b", "esc")], "linux");
    expect(titles(clash[0].bindings.get("escape"))).toEqual(["a", "b"]);
    expect(buildKeyboardMap([], "linux").map((l) => l.label)).toEqual(["No modifier"]);
  });

  test("skips a shortcut that doesn't parse", () => {
    expect(layerSize(buildKeyboardMap([cmd("bad", "mod")], "linux")[0])).toBe(0);
  });
});

test("every board key has a cap label, and modifier caps follow the platform", () => {
  for (const platform of ["macos", "windows"] as const) {
    const rows = boardRows(platform);
    for (const key of rows.flat()) expect(typeof capLabel(key, platform)).toBe("string");
    expect(rows[4].map((key) => capLabel(key, platform))).toEqual(
      platform === "macos"
        ? ["fn", "⌃", "⌥", "⌘", "", "⌘", "⌥", "←", "↑", "↓", "→"]
        : ["Ctrl", "Win", "Alt", "", "Alt", "Ctrl", "←", "↑", "↓", "→"],
    );
  }
});
