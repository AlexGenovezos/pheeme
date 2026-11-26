import raw from "unicode-emoji-json/data-by-group.json";
import { beforeEach, expect, test } from "vitest";
import { emojiGroups, recentEmoji, rememberEmoji, searchEmoji } from "./emoji";

const groups = emojiGroups(raw);

beforeEach(() => localStorage.clear());

test("Unicode's groups, each with a tab icon, without emoji newer than 15.0", () => {
  expect(groups.map((g) => g.name)).toContain("Smileys & Emotion");
  expect(groups.every((g) => g.icon && g.emojis.length > 0)).toBe(true);
  const all = groups.flatMap((g) => g.emojis.map((e) => e.char));
  expect(all).toContain("😀");
  // 🫨 (shaking face) is Emoji 15.0, 🙂‍↔️ (head shaking horizontally) 15.1.
  expect(all).toContain("🫨");
  expect(all).not.toContain("🙂‍↔️");
});

test("search matches the start of each word of the name", () => {
  expect(searchEmoji(groups, "thumbs up").map((e) => e.char)).toContain("👍");
  expect(searchEmoji(groups, "heart").length).toBeGreaterThan(10);
  expect(searchEmoji(groups, "eart")).toEqual([]);
  expect(searchEmoji(groups, "  ")).toEqual([]);
});

test("recently used emoji, newest first, each once", () => {
  expect(recentEmoji()).toEqual([]);
  rememberEmoji("👍");
  rememberEmoji("🎉");
  rememberEmoji("👍");
  expect(recentEmoji()).toEqual(["👍", "🎉"]);
  localStorage.setItem("pheeme.compose.recentEmoji", "{broken");
  expect(recentEmoji()).toEqual([]);
});
