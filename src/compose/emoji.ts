// The emoji picker's rules: which emoji it offers, in what groups, how a search matches, and the recently used
// ones. The data (Unicode's emoji list, from `unicode-emoji-json`) is passed in, so only the lazy-loaded picker
// carries it.
import { readJson, writeJson } from "../lib/storage";

export interface Emoji {
  char: string;
  name: string;
}

export interface EmojiGroup {
  id: string;
  name: string;
  /** The emoji its tab shows. */
  icon: string;
  emojis: Emoji[];
}

/** One group of `unicode-emoji-json`'s `data-by-group.json`. */
export interface RawGroup {
  name: string;
  slug: string;
  emojis: Array<{ emoji: string; name: string; emoji_version: string }>;
}

/**
 * The newest emoji version offered. Emoji 15.0 (2022) shows on every system Pheeme runs on (macOS 13.3+, current
 * Windows and Linux fonts); newer ones would draw as empty boxes for the sender, or the reader, on older ones.
 */
const MAX_VERSION = 15.0;

const ICONS: Record<string, string> = {
  smileys_emotion: "😀",
  people_body: "👋",
  animals_nature: "🐻",
  food_drink: "🍔",
  travel_places: "🚗",
  activities: "⚽",
  objects: "💡",
  symbols: "🔣",
  flags: "🏁",
};

/** Unicode's groups, in Unicode's order, with the emoji every system can draw. */
export function emojiGroups(raw: readonly RawGroup[]): EmojiGroup[] {
  return raw
    .map((g) => ({
      id: g.slug,
      name: g.name,
      icon: ICONS[g.slug] ?? g.emojis[0]?.emoji ?? "",
      emojis: g.emojis
        .filter((e) => Number.parseFloat(e.emoji_version) <= MAX_VERSION)
        .map((e) => ({ char: e.emoji, name: e.name })),
    }))
    .filter((g) => g.emojis.length > 0);
}

/** The emoji whose name has a word starting with each word of `query` ("thumb up" finds 👍), in group order. */
export function searchEmoji(groups: readonly EmojiGroup[], query: string): Emoji[] {
  const words = query
    .toLowerCase()
    .split(/[\s_:]+/)
    .filter(Boolean);
  if (words.length === 0) return [];
  return groups.flatMap((g) =>
    g.emojis.filter((e) => {
      const name = e.name.toLowerCase().split(/[\s:,-]+/);
      return words.every((w) => name.some((n) => n.startsWith(w)));
    }),
  );
}

const RECENT_KEY = "pheeme.compose.recentEmoji";
const MAX_RECENT = 16;

/** The emoji used last, newest first. */
export function recentEmoji(storage?: Pick<Storage, "getItem">): string[] {
  const stored = readJson(RECENT_KEY, storage);
  return Array.isArray(stored)
    ? stored.filter((s): s is string => typeof s === "string").slice(0, MAX_RECENT)
    : [];
}

/** Put `char` at the front of the recently used emoji. */
export function rememberEmoji(char: string, storage?: Pick<Storage, "getItem" | "setItem">) {
  const next = [char, ...recentEmoji(storage).filter((c) => c !== char)].slice(0, MAX_RECENT);
  writeJson(RECENT_KEY, next, storage);
}
