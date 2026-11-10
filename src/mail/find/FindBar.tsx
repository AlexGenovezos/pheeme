import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconButton } from "../../components/ui/IconButton";
import { TextInput } from "../../components/ui/TextInput";
import { platform } from "../../lib/platform";
import { useThemeStore } from "../../theme/theme";
import { findMatches, isStale } from "./findText";
import { clearMatches, paintMatches, revealMatch, screenRect } from "./highlight";
import "./find.css";

/** The conversation on screen (neighbours rendered for preloading are hidden). */
const VISIBLE = '.thread-view__retained[data-visible="true"]';

/** Content changes settle this long before the matches are found again. */
const REFRESH_MS = 120;

interface State {
  matches: Range[];
  capped: boolean;
  index: number;
}

const EMPTY: State = { matches: [], capped: false, index: -1 };

/** "3 of 12", "No matches", or nothing before anything is typed. */
function countLabel(query: string, { matches, capped, index }: State): string {
  if (!query.trim()) return "";
  if (matches.length === 0) return "No matches";
  return `${(index + 1).toLocaleString()} of ${matches.length.toLocaleString()}${capped ? "+" : ""}`;
}

/**
 * Find in the open conversation (mod+f): a bar over the reading pane's top corner. Typing highlights every
 * match in the headers, plain-text bodies and HTML emails; Enter and Shift+Enter (or the arrows, or mod+g)
 * step through them, Escape closes. `request` changes each time mod+f is pressed, which refocuses the field.
 */
export function FindBar({
  pane,
  openKey,
  request,
  onClose,
}: {
  pane: RefObject<HTMLDivElement | null>;
  openKey: string;
  request: number;
  onClose(): void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<State>(EMPTY);
  const latest = useRef({ query, state });
  useLayoutEffect(() => {
    latest.current = { query, state };
  });

  // Focus the field (and select what's there, to type over) every time mod+f is pressed.
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [request]);

  // Where focus was before the bar opened, to give it back on close.
  const returnTo = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const active = document.activeElement;
    returnTo.current = active && !bar.current?.contains(active) ? active : null;
  }, []);
  const close = useCallback(() => {
    const back = returnTo.current;
    if (back instanceof HTMLElement && back.isConnected && back !== document.body)
      back.focus({ preventScroll: true });
    else pane.current?.focus({ preventScroll: true });
    onClose();
  }, [onClose, pane]);

  /**
   * Find again. `fresh` (a new query or conversation) starts at the first match on screen; otherwise the
   * current match stays current if it's still there.
   */
  const search = useCallback(
    (fresh: boolean) => {
      const root = pane.current?.querySelector(VISIBLE);
      const { query: text, state: prev } = latest.current;
      const found = root ? findMatches(root, text) : { matches: [], capped: false };
      const { matches } = found;
      let index = -1;
      if (matches.length && !fresh) {
        const old = prev.matches[prev.index];
        index = old
          ? matches.findIndex(
              (m) => m.startContainer === old.startContainer && m.startOffset === old.startOffset,
            )
          : -1;
        if (index < 0) index = Math.min(Math.max(prev.index, 0), matches.length - 1);
      } else if (matches.length) {
        const top =
          (pane.current?.getBoundingClientRect().top ?? 0) + (bar.current?.offsetHeight ?? 0);
        index = Math.max(
          0,
          matches.findIndex((m) => (screenRect(m)?.bottom ?? Infinity) > top),
        );
      }
      setState({ ...found, index });
    },
    [pane],
  );

  // Reveal only when the user moved to a match (typing, Enter), not when the page changed under it.
  const revealNext = useRef(false);

  // A new query or conversation.
  useEffect(() => {
    revealNext.current = true;
    search(true);
  }, [query, openKey, search]);

  // The conversation changed under the matches: a message opened, a reply arrived, the theme rewrote the
  // email frames. Find again, keeping the current match.
  useEffect(() => {
    const scroller = pane.current;
    if (!scroller) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(() => search(false), REFRESH_MS);
    };
    const observer = new MutationObserver(later);
    observer.observe(scroller, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-visible"],
    });
    const offTheme = useThemeStore.subscribe(later);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      offTheme();
    };
  }, [pane, search]);

  useEffect(() => {
    paintMatches(state.matches, state.index);
    const current = state.matches[state.index];
    if (current && revealNext.current && pane.current)
      revealMatch(current, pane.current, (bar.current?.offsetHeight ?? 0) * 1.5);
    revealNext.current = false;
  }, [state, pane]);

  useEffect(() => clearMatches, []);

  const step = (by: 1 | -1) => {
    const { matches, index: at } = latest.current.state;
    revealNext.current = true;
    if (matches.some(isStale)) {
      search(false);
      return;
    }
    if (!matches.length) return;
    const index = (at + by + matches.length) % matches.length;
    setState((s) => ({ ...s, index }));
  };

  const none = Boolean(query.trim()) && state.matches.length === 0;
  return (
    <div
      ref={bar}
      className="find-bar"
      role="search"
      aria-label="Find in conversation"
      // Its buttons mustn't pass `e` or `#` on to the conversation.
      data-owns-keys
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
        e.preventDefault();
        e.stopPropagation();
        close();
      }}
    >
      <TextInput
        ref={input}
        className="find-bar__input"
        value={query}
        placeholder="Find in conversation"
        aria-label="Find in conversation"
        invalid={none}
        leading={<Search />}
        trailing={
          <span className="find-bar__count" aria-live="polite">
            {countLabel(query, state)}
          </span>
        }
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          const mod = platform === "macos" ? e.metaKey : e.ctrlKey;
          const key = e.key.toLowerCase();
          if (e.key === "Enter" || (mod && key === "g")) step(e.shiftKey ? -1 : 1);
          else if (mod && key === "f") e.currentTarget.select();
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      />
      <IconButton
        size="sm"
        label="Previous match"
        shortcut="shift+enter"
        icon={<ChevronUp />}
        disabled={state.matches.length === 0}
        onClick={() => step(-1)}
      />
      <IconButton
        size="sm"
        label="Next match"
        shortcut="enter"
        icon={<ChevronDown />}
        disabled={state.matches.length === 0}
        onClick={() => step(1)}
      />
      <IconButton size="sm" label="Close" shortcut="escape" icon={<X />} onClick={close} />
    </div>
  );
}
