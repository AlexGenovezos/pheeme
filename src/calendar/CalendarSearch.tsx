// Calendar search (`/`): cached events from a year back to two years ahead whose title, place,
// description or guests match, in place of the grid. Picking one jumps to its day and opens it.
import { Search, X } from "lucide-react";
import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { IconButton } from "../components/ui/IconButton";
import { Skeleton } from "../components/ui/Skeleton";
import { type CalendarEvent, searchCalendarEvents, toCommandError } from "../lib/tauri";
import { cx } from "../lib/utils";
import { revealEvent } from "./actions";
import { displayZone, useCalendarStore } from "./calendarStore";
import { eventColors } from "./colors";
import { addDays, dateOf, formatDay, zonedMs } from "./dates";
import { useEditStore } from "./editStore";
import { useNow } from "./useNow";
import { eventKey, eventTitle, timeSpan, useCalendarLookup } from "./EventBlock";

/** How long typing pauses before the search runs, in ms. */
const DEBOUNCE_MS = 150;

type Results =
  | { query: string; state: "ready"; events: CalendarEvent[] }
  | { query: string; state: "failed"; message: string };

const NONE: CalendarEvent[] = [];

const closeSearch = () => useEditStore.setState({ search: null });

export function CalendarSearch() {
  const query = useEditStore((s) => s.search ?? "");
  const accounts = useCalendarStore((s) => s.accounts);
  const tz = displayZone(accounts);
  const lookup = useCalendarLookup();
  const [results, setResults] = useState<Results | null>(null);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const latest = useRef(0);
  const trimmed = query.trim();
  const today = dateOf(useNow(), tz);

  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    // Only the latest search's answer is kept: an older one arriving late is dropped.
    const ticket = ++latest.current;
    if (!trimmed) return;
    const timer = setTimeout(() => {
      const from = zonedMs(addDays(today, -365), 0, tz);
      const to = zonedMs(addDays(today, 2 * 365), 0, tz);
      const answer = (r: Results) => ticket === latest.current && setResults(r);
      searchCalendarEvents(trimmed, from, to, tz).then(
        (events) => answer({ query: trimmed, state: "ready", events }),
        (e: unknown) =>
          answer({ query: trimmed, state: "failed", message: toCommandError(e).message }),
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trimmed, tz, today]);

  const current = results?.query === trimmed ? results : null;
  const events = current?.state === "ready" ? current.events : NONE;
  // Start at the first event from today on, as the website's list does.
  const firstUpcoming = Math.max(
    0,
    events.findIndex((e) => (e.start.date ?? dateOf(e.start.ms ?? 0, tz)) >= today),
  );
  const [seen, setSeen] = useState<CalendarEvent[] | null>(null);
  if (current?.state === "ready" && seen !== events) {
    setSeen(events);
    setActive(firstUpcoming);
  }
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active, events]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeSearch();
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && events.length) {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => Math.min(events.length - 1, Math.max(0, a + step)));
    } else if (e.key === "Enter" && events[active]) {
      e.preventDefault();
      void revealEvent(events[active]);
    }
  };

  const dayOf = (e: CalendarEvent) => e.start.date ?? dateOf(e.start.ms ?? 0, tz);
  return (
    <div className="cal-search" role="search">
      <div className="cal-search__bar">
        <span className="ui-input cal-search__input">
          <span className="ui-input__adornment">
            <Search aria-hidden="true" />
          </span>
          <input
            ref={input}
            className="ui-input__field"
            placeholder="Search events"
            aria-label="Search events"
            role="combobox"
            aria-expanded={events.length > 0}
            aria-controls="cal-search-results"
            aria-activedescendant={events[active] ? `cal-search-${active}` : undefined}
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(e) => useEditStore.setState({ search: e.currentTarget.value })}
            onKeyDown={onKeyDown}
          />
        </span>
        <IconButton label="Close search" icon={<X />} onClick={closeSearch} />
      </div>
      {!trimmed ? (
        <p className="cal-search__note">
          Search titles, places, descriptions and guests of events from a year ago to two years
          ahead.
        </p>
      ) : !current ? (
        <ul className="cal-search__results" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <li key={i} className="cal-search__row">
              <Skeleton width="30%" />
            </li>
          ))}
        </ul>
      ) : current.state === "failed" ? (
        <p className="cal-search__note" role="alert">
          {current.message}
        </p>
      ) : events.length === 0 ? (
        <p className="cal-search__note">No events match “{trimmed}”.</p>
      ) : (
        <ul
          ref={list}
          id="cal-search-results"
          className="cal-search__results"
          role="listbox"
          aria-label="Matching events"
        >
          {events.map((e, i) => {
            const day = dayOf(e);
            const newDay = i === 0 || dayOf(events[i - 1]) !== day;
            const { background } = eventColors(e, lookup(e));
            return (
              <li
                key={eventKey(e)}
                id={`cal-search-${i}`}
                data-index={i}
                role="option"
                aria-selected={i === active}
                className={cx("cal-search__row", day < today && "cal-search__row--past")}
                style={{ "--cal-event-bg": background } as CSSProperties}
                onPointerMove={() => i !== active && setActive(i)}
                onClick={() => void revealEvent(e)}
              >
                <span className="cal-search__day">
                  {newDay &&
                    formatDay(day, {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                </span>
                <span className="cal-event__dot" aria-hidden="true" />
                <span className="cal-search__time">{e.allDay ? "All day" : timeSpan(e, tz)}</span>
                <span className="cal-search__title">{eventTitle(e)}</span>
                {e.location && <span className="cal-search__location">{e.location}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
