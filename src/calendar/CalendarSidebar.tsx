// Calendar mode's sidebar: the mode switch, a mini month for jumping to any day, and each
// account's calendars with Google's colours and a tick to show or hide each one.
import { NotificationOffer } from "../desktop/NotificationOffer";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  PanelLeftClose,
  Plus,
  TriangleAlert,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import { focusFromKeyboard } from "../keyboard/focus";
import { describeShortcut } from "../keyboard/format";
import { Skeleton } from "../components/ui/Skeleton";
import { useKeybinding } from "../keyboard/useCommands";
import type { CalendarAccount, CalendarEvent, CalendarInfo } from "../lib/tauri";
import { cx } from "../lib/utils";
import { dragRegion } from "../shell/chrome";
import { useUiStore } from "../store/uiStore";
import { AccountAccess, syncLine } from "./AccessControls";
import { openQuickAdd } from "./actions";
import { screenDays, useCalendarStore, weekStartOf, displayZone } from "./calendarStore";
import { CalendarColorButton, useCalendarColor } from "./CalendarColor";
import { calendarColor, eventColors, textOn } from "./colors";
import { addDays, addMonths, formatDay, startOfMonth } from "./dates";
import { useCalendarLookup } from "./EventBlock";
import { gridKeyStep } from "./MonthGrid";
import { eventDays } from "./layout";
import { useRangeEvents } from "./rangeEvents";
import { SidebarAgenda } from "./SidebarAgenda";
import { TravelNote } from "./TravelNote";
import { SidebarFooter } from "../shell/SidebarFooter";
import { SidebarTaskLists } from "../tasks/SidebarTaskLists";
import { useToday } from "./useNow";
import { visibleDays } from "./views";

/** Each day's dots: the colours of up to three of its calendars, from `first` through `last`. */
function dayDots(
  events: CalendarEvent[] | null,
  tz: string,
  lookup: ReturnType<typeof useCalendarLookup>,
  first: string,
  last: string,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const e of events ?? []) {
    if (e.selfResponse === "declined") continue;
    const span = eventDays(e, tz);
    if (!span) continue;
    const color = eventColors(e, lookup(e)).background;
    const from = span.first < first ? first : span.first;
    for (let d = from; d <= span.last && d <= last; d = addDays(d, 1)) {
      const list = map.get(d) ?? [];
      if (list.length < 3 && !list.includes(color)) list.push(color);
      map.set(d, list);
    }
  }
  return map;
}

function MiniMonth() {
  const anchor = useCalendarStore((s) => s.anchor);
  const accounts = useCalendarStore((s) => s.accounts);
  const view = useCalendarStore((s) => s.view);
  const weekStart = weekStartOf(accounts);
  const today = useToday(displayZone(accounts));
  // The month shown; it follows the main view whenever that moves.
  const [shown, setShown] = useState(() => ({ anchor, month: startOfMonth(anchor) }));
  if (shown.anchor !== anchor) setShown({ anchor, month: startOfMonth(anchor) });
  const month = shown.month;
  const setMonth = (m: string) => setShown({ anchor, month: m });

  const days = useMemo(() => visibleDays("month", month, weekStart), [month, weekStart]);
  // Day and Week mark their days; Month is the whole grid already.
  const onScreen = useMemo(
    () => new Set(view === "month" ? [] : screenDays({ view, anchor, accounts }).days),
    [view, anchor, accounts],
  );
  const labelId = useId();
  const weeks = Array.from({ length: days.length / 7 }, (_, w) => days.slice(w * 7, w * 7 + 7));
  // Up to three dots under a day, in the colours of what's on it.
  const events = useRangeEvents(days[0], days[days.length - 1]);
  const lookup = useCalendarLookup();
  const tz = displayZone(accounts);
  const dots = useMemo(
    () => dayDots(events, tz, lookup, days[0], days[days.length - 1]),
    [events, tz, lookup, days],
  );

  // Roving focus, as in the Month view: one day is in the tab order, the last one focused, else the
  // day the calendar is on, else today, else the 1st. Arrows move by day and week, Home/End to the
  // week's ends, Page Up/Down by month; Enter or Space shows the day.
  const gridRef = useRef<HTMLTableElement>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const tabStop =
    focused && days.includes(focused)
      ? focused
      : days.includes(anchor)
        ? anchor
        : days.includes(today)
          ? today
          : `${month.slice(0, 7)}-01`;
  const focusDay = (day: string) => {
    const button = gridRef.current?.querySelector<HTMLElement>(
      `[data-date="${day}"] .mini-month__day`,
    );
    if (!button) return false;
    pendingFocus.current = null;
    focusFromKeyboard(button);
    return true;
  };
  // A move past the edge shows the other month first; focus the day once it's drawn.
  useEffect(() => {
    if (pendingFocus.current) focusDay(pendingFocus.current);
  });
  const onKeyDown = (e: KeyboardEvent<HTMLTableElement>) => {
    const step = gridKeyStep(e, "mini-month__day", days);
    if (!step) return;
    const { next, byMonth } = step;
    e.preventDefault();
    e.stopPropagation();
    setFocused(next);
    if (byMonth || !focusDay(next)) {
      pendingFocus.current = next;
      setMonth(startOfMonth(next));
    }
  };

  return (
    <div className="mini-month">
      <div className="mini-month__head">
        <span id={labelId} className="mini-month__title">
          {formatDay(month, { month: "long" })}{" "}
          <span className="mini-month__year">{formatDay(month, { year: "numeric" })}</span>
        </span>
        <IconButton
          size="sm"
          label="Previous month"
          icon={<ChevronLeft />}
          onClick={() => setMonth(addMonths(month, -1))}
        />
        <IconButton
          size="sm"
          label="Next month"
          icon={<ChevronRight />}
          onClick={() => setMonth(addMonths(month, 1))}
        />
      </div>
      <table
        className="mini-month__grid"
        aria-labelledby={labelId}
        ref={gridRef}
        onKeyDown={onKeyDown}
      >
        <thead>
          <tr>
            {days.slice(0, 7).map((d) => (
              <th key={d} scope="col" abbr={formatDay(d, { weekday: "long" })}>
                {formatDay(d, { weekday: "narrow" })}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]}>
              {week.map((d, i) => (
                <td
                  key={d}
                  data-date={d}
                  className={cx(
                    onScreen.has(d) && "mini-month__cell--shown",
                    onScreen.has(d) &&
                      !onScreen.has(week[i - 1] ?? "") &&
                      "mini-month__cell--shown-start",
                    onScreen.has(d) &&
                      !onScreen.has(week[i + 1] ?? "") &&
                      "mini-month__cell--shown-end",
                  )}
                >
                  <button
                    type="button"
                    className={cx(
                      "mini-month__day",
                      d.slice(0, 7) !== month.slice(0, 7) && "mini-month__day--other",
                      d === today && "mini-month__day--today",
                    )}
                    aria-current={d === today ? "date" : undefined}
                    aria-label={formatDay(d, { weekday: "long", month: "long", day: "numeric" })}
                    tabIndex={d === tabStop ? 0 : -1}
                    onFocus={() => setFocused(d)}
                    onClick={() => useCalendarStore.getState().goTo(d)}
                  >
                    {Number(d.slice(8))}
                    <span className="mini-month__dots" aria-hidden="true">
                      {(dots.get(d) ?? []).map((c) => (
                        <span key={c} className="mini-month__dot" style={{ background: c }} />
                      ))}
                    </span>
                  </button>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CalendarRow({ account, calendar }: { account: CalendarAccount; calendar: CalendarInfo }) {
  const color = calendarColor(calendar);
  const shown = !calendar.hidden;
  const name = calendar.primary ? account.email : calendar.summary;
  const picker = useCalendarColor(account.accountId, calendar);
  return (
    <div
      className="cal-sidebar__calendar-row"
      onContextMenu={(e) => {
        e.preventDefault();
        picker.openAt({ x: e.clientX, y: e.clientY }, null);
      }}
    >
      <label className="cal-sidebar__calendar" title={calendar.summary}>
        <input
          type="checkbox"
          className="cal-sidebar__check-input"
          checked={shown}
          onChange={(e) =>
            void useCalendarStore
              .getState()
              .setHidden(account.accountId, calendar.id, !e.currentTarget.checked)
          }
        />
        <span
          className="cal-sidebar__check"
          style={{
            background: shown ? color : undefined,
            borderColor: color,
            color: textOn(color),
          }}
          aria-hidden="true"
        >
          {shown && <Check />}
        </span>
        <span className="cal-sidebar__calendar-name">{name}</span>
      </label>
      <CalendarColorButton name={name} open={picker.open} onOpen={picker.openAt} />
      {picker.popover}
    </div>
  );
}

function AccountGroup({ account }: { account: CalendarAccount }) {
  const id = useId();
  const on = account.access.status === "on";
  const failing = account.access.status === "error" || account.access.status === "api_disabled";
  // Own calendars first, then other people's and subscribed ones, as on the website.
  const calendars = [...account.calendars].sort(
    (a, b) =>
      Number(b.primary) - Number(a.primary) ||
      Number(b.accessRole === "owner") - Number(a.accessRole === "owner") ||
      a.summary.localeCompare(b.summary),
  );
  return (
    <section className="sidebar__section" aria-labelledby={id}>
      <h2 id={id} className="sidebar__heading cal-sidebar__account" title={account.email}>
        {account.email}
      </h2>
      {calendars.map((c) => (
        <CalendarRow key={c.id} account={account} calendar={c} />
      ))}
      <SidebarTaskLists accountId={account.accountId} />
      <p className={cx("cal-sidebar__status", failing && "cal-sidebar__status--error")}>
        {failing && <TriangleAlert aria-hidden="true" />}
        <span>{syncLine(account)}</span>
      </p>
      {!on && <AccountAccess account={account} />}
    </section>
  );
}

export function CalendarSidebar({ onAddAccount }: { onAddAccount?: () => void }) {
  const accounts = useCalendarStore((s) => s.accounts);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const sidebarShortcut = useKeybinding("view.toggleSidebar");
  const createShortcut = useKeybinding("calendar.create");
  return (
    <div className="sidebar cal-sidebar">
      <div className="toolbar toolbar--sidebar" {...dragRegion}>
        <span className="toolbar__spacer" {...dragRegion} />
        <IconButton
          label="Hide sidebar"
          data-command="view.toggleSidebar"
          shortcut={sidebarShortcut}
          icon={<PanelLeftClose />}
          onClick={toggleSidebar}
        />
      </div>
      <div className="sidebar__compose">
        <Button
          variant="primary"
          size="lg"
          icon={<Plus aria-hidden="true" />}
          data-command="calendar.create"
          title={createShortcut ? `Create event (${describeShortcut(createShortcut)})` : undefined}
          onClick={openQuickAdd}
        >
          Create
        </Button>
      </div>
      <nav className="sidebar__scroll" aria-label="Calendars">
        <MiniMonth />
        <SidebarAgenda />
        {accounts === null ? (
          <section className="sidebar__section" aria-hidden="true">
            <span className="sidebar__heading">
              <Skeleton width="70%" />
            </span>
            {[0, 1, 2].map((i) => (
              <span key={i} className="cal-sidebar__calendar">
                <Skeleton width="60%" />
              </span>
            ))}
          </section>
        ) : (
          accounts.map((a) => <AccountGroup key={a.accountId} account={a} />)
        )}
      </nav>
      <TravelNote />
      <NotificationOffer />
      <SidebarFooter onAddAccount={onAddAccount} />
    </div>
  );
}
