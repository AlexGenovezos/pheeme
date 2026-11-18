import { RotateCw, Search, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { IconButton } from "../components/ui/IconButton";
import { Kbd } from "../components/ui/Kbd";
import { TextInput } from "../components/ui/TextInput";
import { useKeybinding } from "../keyboard/useCommands";
import { addRecentSearch, recentSearches, removeRecentSearch, toCommandError } from "../lib/tauri";
import { useLabelStore } from "../store/labelStore";
import { useMailStore } from "../store/mailStore";
import { useUiStore } from "../store/uiStore";
import { suggest } from "./operators";
import { SearchOptions } from "./SearchOptions";
import "./search.css";
import "../components/ui/Surface.css";

export const SEARCH_INPUT_ID = "mail-search";

/** What Gmail's half of the search is doing, with a retry when it failed. Drawn in the list's controls row. */
export function SearchStatus() {
  const search = useMailStore((s) => s.search);
  const error = search?.remoteError;
  return (
    <span className="mail-search__status" id="search-status" role="status" aria-live="polite">
      {error ? (
        // An icon, so the row still fits beside Select all and Mark all as read in a narrow list.
        <IconButton
          size="sm"
          label="Retry Gmail"
          title={`Gmail search incomplete: ${error.message}. Retry Gmail`}
          icon={<RotateCw />}
          disabled={search?.remoteLoading}
          onClick={() => void useMailStore.getState().retryGmail()}
        />
      ) : (
        <span>
          {!search
            ? ""
            : search.remoteLoading
              ? "Searching Gmail…"
              : search.local === false
                ? "Results from Gmail"
                : ""}
        </span>
      )}
    </span>
  );
}

export function SearchBar() {
  const text = useUiStore((s) => s.searchText);
  const setSearch = useUiStore((s) => s.setSearch);
  const input = useRef<HTMLInputElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const historyVersion = useRef(0);
  const [focused, setFocused] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const [options, setOptions] = useState<{ x: number; y: number } | null>(null);
  const optionsButton = useRef<HTMLButtonElement>(null);
  const allLabels = useLabelStore((s) => s.labels);
  const shortcut = useKeybinding("search.focus");
  const active = text.trim().length > 0;
  const labelNames = useMemo(
    () => [
      ...new Set(
        Object.values(allLabels)
          .flat()
          .filter((l) => l.type === "user")
          .map((l) => l.name),
      ),
    ],
    [allLabels],
  );
  const operators = suggest(text, Math.min(caret, text.length), labelNames);

  useEffect(() => {
    const version = ++historyVersion.current;
    let live = true;
    if (!focused) return;
    void recentSearches()
      .then((rows) => {
        if (live && version === historyVersion.current) {
          setRecent(rows ?? []);
          setHistoryError(null);
        }
      })
      .catch((error) => {
        if (live && version === historyVersion.current)
          setHistoryError(toCommandError(error).message);
      });
    return () => {
      // oxlint-disable-next-line react/immutability -- This flag belongs to this effect invocation.
      live = false;
    };
  }, [focused]);

  const remember = () => {
    if (!active) return;
    historyVersion.current++;
    void addRecentSearch(text.trim())
      .then(() => {
        setRecent((rows) => [text.trim(), ...rows.filter((q) => q !== text.trim())].slice(0, 20));
      })
      .catch((error) => setHistoryError(toCommandError(error).message));
  };
  const clear = () => {
    setSearch("");
    input.current?.focus();
    setFocused(false);
  };
  const forget = async (query: string) => {
    historyVersion.current++;
    try {
      await removeRecentSearch(query);
      setRecent((rows) => rows.filter((q) => q !== query));
    } catch (error) {
      setHistoryError(toCommandError(error).message);
    }
  };
  const suggestions = recent.filter((q) => !active || q.toLowerCase().includes(text.toLowerCase()));
  const complete = (insert: string) => {
    const next = text.slice(0, operators.start) + insert + text.slice(caret);
    const at = operators.start + insert.length;
    setSearch(next);
    setCaret(at);
    const el = input.current;
    el?.focus();
    requestAnimationFrame(() => el?.setSelectionRange(at, at));
  };
  const openOptions = () => {
    const box = input.current?.closest(".ui-input")?.getBoundingClientRect();
    setFocused(false);
    setOptions(box ? { x: box.left, y: box.bottom + 4 } : { x: 0, y: 0 });
  };

  const track = (el: HTMLInputElement) => setCaret(el.selectionStart ?? el.value.length);
  const listed = [...operators.items.map((o) => o.label), ...suggestions];
  const moveIn = (from: HTMLElement, step: 1 | -1) => {
    const buttons = [
      ...(history.current?.querySelectorAll<HTMLButtonElement>(".mail-search__suggestion") ?? []),
    ];
    const next = buttons.indexOf(from as HTMLButtonElement) + step;
    if (next < 0) input.current?.focus();
    else buttons[Math.min(next, buttons.length - 1)]?.focus();
  };

  return (
    <div
      className="mail-search"
      data-owns-keys
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) {
          setFocused(false);
          remember();
        }
      }}
    >
      <TextInput
        ref={input}
        id={SEARCH_INPUT_ID}
        type="search"
        value={text}
        placeholder="Search mail"
        aria-label="Search mail"
        aria-describedby={active ? "search-status" : undefined}
        leading={<Search />}
        trailing={
          <>
            {text ? (
              <IconButton size="sm" label="Clear search" icon={<X />} onClick={clear} />
            ) : (
              shortcut && <Kbd shortcut={shortcut} />
            )}
            <IconButton
              ref={optionsButton}
              size="sm"
              label="Search options"
              aria-haspopup="dialog"
              aria-expanded={options !== null}
              icon={<SlidersHorizontal />}
              onClick={() => (options ? setOptions(null) : openOptions())}
            />
          </>
        }
        onChange={(e) => {
          setSearch(e.target.value);
          track(e.target);
          setFocused(true);
        }}
        onSelect={(e) => track(e.currentTarget)}
        onFocus={() => setFocused(true)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            if (text) clear();
            else {
              setFocused(false);
              e.currentTarget.blur();
            }
          } else if (e.key === "Tab" && !e.shiftKey && focused && operators.items.length) {
            e.preventDefault();
            complete(operators.items[0].insert);
          } else if (e.key === "Enter") {
            e.preventDefault();
            remember();
            setFocused(false);
            document.querySelector<HTMLElement>('.shell__list [role="listbox"]')?.focus();
          } else if (e.key === "ArrowDown" && focused && listed.length) {
            e.preventDefault();
            history.current?.querySelector<HTMLButtonElement>("button")?.focus();
          }
        }}
      />
      {focused && (listed.length > 0 || historyError) && (
        <div
          className="mail-search__recent popover-surface"
          ref={history}
          role="region"
          aria-label={operators.items.length ? "Search suggestions" : "Recent searches"}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              input.current?.focus();
              setFocused(false);
            } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              moveIn(e.target as HTMLElement, e.key === "ArrowDown" ? 1 : -1);
            }
          }}
        >
          {operators.items.length > 0 && (
            <>
              <p className="mail-search__heading">Search operators</p>
              {operators.items.map((o) => (
                <div className="mail-search__recent-row" key={o.label}>
                  <button
                    className="mail-search__suggestion"
                    type="button"
                    onClick={() => complete(o.insert)}
                  >
                    <span className="mail-search__operator">{o.label}</span>
                    <span className="mail-search__hint">{o.hint}</span>
                  </button>
                </div>
              ))}
            </>
          )}
          {suggestions.length > 0 && <p className="mail-search__heading">Recent searches</p>}
          {suggestions.map((q) => (
            <div className="mail-search__recent-row" key={q}>
              <button
                className="mail-search__suggestion"
                type="button"
                onClick={() => {
                  setSearch(q);
                  input.current?.focus();
                  setFocused(false);
                  void addRecentSearch(q).catch((error) =>
                    setHistoryError(toCommandError(error).message),
                  );
                }}
              >
                {q}
              </button>
              <IconButton
                size="sm"
                label={`Forget search: ${q}`}
                icon={<X />}
                onClick={() => void forget(q)}
              />
            </div>
          ))}
          {historyError && <p role="alert">{historyError}</p>}
        </div>
      )}
      {options && (
        <SearchOptions at={options} toggle={optionsButton} onClose={() => setOptions(null)} />
      )}
    </div>
  );
}
