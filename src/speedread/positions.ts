/**
 * Where the reader stopped in each email, so reopening one picks up from there, even after a restart.
 * Only the most recent emails are kept; finishing one (or going back to its start) forgets it.
 */

export const POSITIONS_KEY = "pheeme.speed-reader.positions";
const LIMIT = 100;

interface Saved {
  id: string;
  index: number;
  /** The email's length in words when saved: a different count means different text, so start over. */
  words: number;
}

function load(): Saved[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(POSITIONS_KEY) ?? "[]");
    return Array.isArray(stored)
      ? stored.filter(
          (s): s is Saved =>
            typeof s?.id === "string" && Number.isInteger(s.index) && Number.isInteger(s.words),
        )
      : [];
  } catch {
    return [];
  }
}

/** The word to pick up from in email `id`, which is `words` words long (0 when there's nothing saved). */
export function savedPosition(id: string, words: number): number {
  const saved = load().find((s) => s.id === id);
  return saved && saved.words === words && saved.index < words ? saved.index : 0;
}

/** Remember the reader is at word `index` of `words` in email `id`. */
export function savePosition(id: string, index: number, words: number) {
  const rest = load().filter((s) => s.id !== id);
  // Nothing to resume at the start, or on the last word, where reading has finished.
  const next = index > 0 && index < words - 1 ? [...rest, { id, index, words }] : rest;
  try {
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(next.slice(-LIMIT)));
  } catch {
    // Storage unavailable: the reader just starts from the top next time.
  }
}
