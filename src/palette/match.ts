import type { Command } from "../keyboard/registry";

export interface Match {
  score: number;
  /** Character positions in the text that matched, for highlighting. */
  indices: number[];
}

const isBoundary = (text: string, i: number) => i === 0 || /[\s\-_/:.]/.test(text[i - 1]);

/**
 * Case-insensitive match: contiguous substrings rank above scattered
 * subsequences, and matches at word starts rank above mid-word ones.
 */
export function fuzzyMatch(query: string, text: string): Match | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const t = text.toLowerCase();

  const at = t.indexOf(q);
  if (at >= 0) {
    // Prefer an occurrence that starts a word ("theme" in "Toggle theme").
    let best = at;
    for (let i = at; i >= 0; i = t.indexOf(q, i + 1)) {
      if (isBoundary(t, i)) {
        best = i;
        break;
      }
    }
    const score = 1000 + (isBoundary(t, best) ? 200 : 0) - best - (t.length - q.length) * 0.1;
    return { score, indices: Array.from({ length: q.length }, (_, k) => best + k) };
  }

  const indices: number[] = [];
  let score = 0;
  let from = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const i = t.indexOf(ch, from);
    if (i < 0) return null;
    score += isBoundary(t, i)
      ? 10
      : indices.length && indices[indices.length - 1] === i - 1
        ? 5
        : 1;
    indices.push(i);
    from = i + 1;
  }
  return { score: score - (indices[indices.length - 1] - indices[0]) * 0.1, indices };
}

export interface CommandResult {
  command: Command;
  indices: number[];
}

/** Palette results: everything (in registration order) for an empty query, else ranked matches. */
export function filterCommands(commands: Command[], query: string): CommandResult[] {
  const visible = commands.filter((c) => !c.hidden);
  if (!query.trim()) return visible.map((command) => ({ command, indices: [] }));

  const scored: Array<CommandResult & { score: number; order: number }> = [];
  visible.forEach((command, order) => {
    const title = fuzzyMatch(query, command.title);
    const extra = [command.group, ...(command.keywords ?? [])]
      .filter((s): s is string => Boolean(s))
      .map((s) => fuzzyMatch(query, s))
      .reduce<number | null>(
        (best, m) => (m && (best == null || m.score > best) ? m.score : best),
        null,
      );
    const extraScore = extra == null ? null : extra * 0.6;
    if (!title && extraScore == null) return;
    const titleScore = title?.score ?? -Infinity;
    scored.push({
      command,
      indices: title && titleScore >= (extraScore ?? -Infinity) ? title.indices : [],
      score: Math.max(titleScore, extraScore ?? -Infinity),
      order,
    });
  });
  return scored.sort((a, b) => b.score - a.score || a.order - b.order);
}
