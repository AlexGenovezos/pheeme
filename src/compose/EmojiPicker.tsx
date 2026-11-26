// Insert emoji: a search field, a tab per Unicode group, and every emoji in one scrolling grid, with the recently
// used ones first. Lazy-loaded with its data (`unicode-emoji-json`, about 32 KB gzipped) the first time it opens.
// It stays open after a pick, as Gmail's does, so several can go in a row. Its size never changes: searching
// swaps what the grid holds, and the name line under it is always there.
import raw from "unicode-emoji-json/data-by-group.json";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import { usePopover } from "../components/ui/usePopover";
import { type Emoji, emojiGroups, recentEmoji, rememberEmoji, searchEmoji } from "./emoji";
import "../components/ui/Surface.css";

const GROUPS = emojiGroups(raw);
const NAMES = new Map(GROUPS.flatMap((g) => g.emojis.map((e) => [e.char, e.name] as const)));

interface Section {
  id: string;
  name: string;
  emojis: Emoji[];
}

/** The next button up or down from `from`: the one on the next row whose left edge is nearest. */
function verticalNeighbour(buttons: HTMLElement[], from: number, down: boolean): number {
  const here = buttons[from].getBoundingClientRect();
  const order = down
    ? buttons.map((_, i) => i).slice(from + 1)
    : buttons
        .map((_, i) => i)
        .slice(0, from)
        .reverse();
  const first = order.find((i) => {
    const top = buttons[i].getBoundingClientRect().top;
    return down ? top > here.top + 1 : top < here.top - 1;
  });
  if (first === undefined) return from;
  const rowTop = buttons[first].getBoundingClientRect().top;
  let best = first;
  for (const i of order.slice(order.indexOf(first))) {
    const rect = buttons[i].getBoundingClientRect();
    if (Math.abs(rect.top - rowTop) > 1) break;
    if (
      Math.abs(rect.left - here.left) <
      Math.abs(buttons[best].getBoundingClientRect().left - here.left)
    )
      best = i;
  }
  return best;
}

export default function EmojiPicker({
  at,
  returnFocus,
  ignore,
  onPick,
  onClose,
}: {
  /** The bottom-left corner: it opens upward from the footer. */
  at: { x: number; y: number };
  returnFocus: HTMLElement | null;
  ignore(target: Node): boolean;
  onPick(char: string): void;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const { pos } = usePopover({
    ref,
    at,
    above: true,
    onClose,
    ignore,
    returnFocus,
    focusIn: (el) => el?.querySelector("input"),
  });
  const [query, setQuery] = useState("");
  // Read once: what's picked now joins the list next time, so the grid never moves under the pointer.
  const [recent] = useState(() => recentEmoji().filter((c) => NAMES.has(c)));
  const [shown, setShown] = useState<Emoji | null>(null);

  const sections = useMemo<Section[]>(() => {
    if (query.trim())
      return [{ id: "results", name: "Search results", emojis: searchEmoji(GROUPS, query) }];
    const used = recent.map((char) => ({ char, name: NAMES.get(char) ?? "" }));
    return [
      ...(used.length ? [{ id: "recent", name: "Recently used", emojis: used }] : []),
      ...GROUPS,
    ];
  }, [query, recent]);
  const first = sections.find((s) => s.emojis.length > 0)?.emojis[0] ?? null;

  const pick = (emoji: Emoji) => {
    onPick(emoji.char);
    rememberEmoji(emoji.char);
  };

  const buttons = () => [
    ...(scroller.current?.querySelectorAll<HTMLElement>(".emoji-picker__emoji") ?? []),
  ];

  const onGridKey = (e: KeyboardEvent) => {
    const all = buttons();
    const from = all.indexOf(document.activeElement as HTMLElement);
    if (from < 0) return;
    let to = from;
    if (e.key === "ArrowRight") to = Math.min(all.length - 1, from + 1);
    else if (e.key === "ArrowLeft") to = Math.max(0, from - 1);
    else if (e.key === "ArrowDown") to = verticalNeighbour(all, from, true);
    else if (e.key === "ArrowUp") {
      to = verticalNeighbour(all, from, false);
      // Up from the top row goes back to the search field.
      if (to === from) {
        ref.current?.querySelector("input")?.focus();
        e.preventDefault();
        return;
      }
    } else return;
    e.preventDefault();
    e.stopPropagation();
    all[to]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };

  return (
    <div
      ref={ref}
      className="emoji-picker popover-surface"
      role="dialog"
      aria-label="Insert emoji"
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onKeyDown}
    >
      <input
        className="emoji-picker__search"
        type="search"
        placeholder="Search emoji"
        aria-label="Search emoji"
        value={query}
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value);
          scroller.current?.scrollTo({ top: 0 });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && first && !(e.metaKey || e.ctrlKey || e.altKey)) {
            e.preventDefault();
            pick(first);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            buttons()[0]?.focus();
          }
        }}
      />
      <div className="emoji-picker__tabs" role="toolbar" aria-label="Emoji groups">
        {GROUPS.map((g) => (
          <button
            key={g.id}
            type="button"
            className="emoji-picker__tab"
            title={g.name}
            aria-label={g.name}
            // Choosing a group while searching shows every group again, scrolled to it.
            onClick={() => {
              setQuery("");
              requestAnimationFrame(() =>
                scroller.current
                  ?.querySelector(`[data-group="${g.id}"]`)
                  ?.scrollIntoView({ block: "start" }),
              );
            }}
          >
            {g.icon}
          </button>
        ))}
      </div>
      <div ref={scroller} className="emoji-picker__scroll" onKeyDown={onGridKey}>
        {sections.map((s) => (
          <section
            key={s.id}
            className="emoji-picker__section"
            data-group={s.id}
            aria-label={s.name}
          >
            <h3 className="emoji-picker__heading">{s.name}</h3>
            {s.emojis.length === 0 ? (
              <p className="emoji-picker__empty">No emoji match.</p>
            ) : (
              <div className="emoji-picker__grid">
                {s.emojis.map((emoji) => (
                  <button
                    key={emoji.char}
                    type="button"
                    className="emoji-picker__emoji"
                    aria-label={emoji.name}
                    // One tab stop for the grid: arrow keys move inside it.
                    tabIndex={emoji === first ? 0 : -1}
                    onPointerEnter={() => setShown(emoji)}
                    onFocus={() => setShown(emoji)}
                    onClick={() => pick(emoji)}
                  >
                    {emoji.char}
                  </button>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
      {/* Always there, so pointing at an emoji never moves anything. */}
      <div className="emoji-picker__name" aria-hidden="true">
        <span className="emoji-picker__name-char">{shown?.char ?? ""}</span>
        <span className="emoji-picker__name-text">{shown?.name ?? "Pick an emoji"}</span>
      </div>
    </div>
  );
}
