import { Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import { Kbd } from "../components/ui/Kbd";
import { TextInput } from "../components/ui/TextInput";
import { useKeybinding } from "../keyboard/useCommands";
import { addRecentSearch, recentSearches, removeRecentSearch, toCommandError } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { useMailStore } from "../store/mailStore";
import { useUiStore } from "../store/uiStore";
import "./search.css";

export const SEARCH_INPUT_ID = "mail-search";

export function SearchBar() {
  const text = useUiStore((s) => s.searchText);
  const scope = useUiStore((s) => s.searchAccountId);
  const setSearch = useUiStore((s) => s.setSearch);
  const accounts = useAccountStore((s) => s.accounts);
  const search = useMailStore((s) => s.search);
  const input = useRef<HTMLInputElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const historyVersion = useRef(0);
  const [focused, setFocused] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const shortcut = useKeybinding("search.focus", "/");
  const active = text.trim().length > 0;

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
  const remoteError = search?.remoteError;

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
          text ? (
            <IconButton size="sm" label="Clear search" icon={<X />} onClick={clear} />
          ) : (
            shortcut && <Kbd shortcut={shortcut} />
          )
        }
        onChange={(e) => setSearch(e.target.value)}
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
          } else if (e.key === "Enter") {
            e.preventDefault();
            remember();
            setFocused(false);
            document.querySelector<HTMLElement>('.shell__list [role="listbox"]')?.focus();
          } else if (e.key === "ArrowDown" && focused && suggestions.length) {
            e.preventDefault();
            history.current?.querySelector<HTMLButtonElement>("button")?.focus();
          }
        }}
      />
      {focused && (suggestions.length > 0 || historyError) && (
        <div
          className="mail-search__recent"
          ref={history}
          role="region"
          aria-label="Recent searches"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              input.current?.focus();
              setFocused(false);
            }
          }}
        >
          <p className="mail-search__heading">Recent searches</p>
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
      {active && (
        <>
          <label className="mail-search__scope">
            <span>Search in</span>
            <select
              aria-label="Search accounts"
              value={scope ?? ""}
              onChange={(e) => useUiStore.getState().setSearchAccount(e.target.value || null)}
            >
              <option value="">All accounts</option>
              {accounts.map((a) => (
                <option value={a.id} key={a.id}>
                  {a.email}
                </option>
              ))}
            </select>
          </label>
          <div className="mail-search__status" id="search-status" role="status" aria-live="polite">
            <span title={remoteError?.message}>
              {remoteError
                ? "Gmail search incomplete"
                : search?.remoteLoading
                  ? "Searching Gmail…"
                  : search?.local === false
                    ? "Results from Gmail"
                    : "Cached mail and Gmail"}
            </span>
            {remoteError && (
              <Button
                size="sm"
                disabled={search?.remoteLoading}
                onClick={() => void useMailStore.getState().retryGmail()}
              >
                Retry Gmail
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
