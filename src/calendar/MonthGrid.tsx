// Month: whole weeks of day cells. Bars for all-day and multi-day events, a dot line for each
// shorter one, and "+N more" where a day has more than fits. Clicking a day opens it in Day view.
import {
  type CSSProperties,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CalendarEvent, Task } from "../lib/tauri";
import { useHeight, useWidth } from "../lib/useWidth";
import { cx } from "../lib/utils";
import { useCalendarStore } from "./calendarStore";
import { focusFromKeyboard } from "../keyboard/focus";
import { addDays, addMonths, daysBetween, dateOf, formatDay } from "./dates";
import { createOnDays } from "./drag";
import { BarEvent, DotEvent, eventKey, timeSpan, useCalendarLookup } from "./EventBlock";
import { fitRows, inAllDayBand, layoutBand } from "./layout";
import { useNow } from "./useNow";
import { TaskChip, useDatedTasks } from "../tasks/DatedTasks";
import { layoutTasks } from "../tasks/gridLayout";
import { taskKey } from "../tasks/outline";
import { withoutBooked } from "../tasks/plan";
import { DayWeather, type DayWeatherFit, weatherFit } from "../weather/DayWeather";

/** One event line in a cell, in px. */
export const MONTH_ROW_PX = 26;
/** Days narrower than this show events by title only. */
const NARROW_DAY_PX = 120;
/** A cell's forecast beside its centred date: high and low from this width, the high alone from the next, else the drawing. */
const WEATHER_FULL_PX = 180;
const WEATHER_HIGH_PX = 120;
/** The day number at the top of a cell, in px. */
export const MONTH_DATE_PX = 28;

function Week({
  days,
  month,
  today,
  tabStop,
  onFocusDay,
  tz,
  events,
  tasks,
  capacity,
  weather,
}: {
  days: string[];
  month: string;
  today: string;
  tabStop: string;
  onFocusDay: (d: string) => void;
  tz: string;
  events: CalendarEvent[];
  tasks: Task[];
  capacity: number;
  weather: DayWeatherFit;
}) {
  const lookup = useCalendarLookup();
  const { visible, more } = useMemo(() => {
    const placed = layoutBand(events, days, tz, true);
    return fitRows([...placed, ...layoutTasks(tasks, days, placed)], days.length, capacity);
  }, [events, tasks, days, tz, capacity]);
  const openDay = (d: string) => useCalendarStore.getState().goTo(d, "day");
  return (
    <div className="cal-month__week" role="row">
      {days.map((d, i) => (
        <div
          key={d}
          role="gridcell"
          className={cx(
            "cal-month__cell",
            d.slice(0, 7) !== month && "cal-month__cell--other",
            d === today && "cal-month__cell--today",
          )}
          style={{ gridColumn: i + 1, gridRow: "1 / -1" }}
          data-cal-drop="day"
          data-date={d}
          onPointerDown={(e) => createOnDays(e, d)}
        >
          <button
            type="button"
            className="cal-month__date"
            aria-label={formatDay(d, { weekday: "long", month: "long", day: "numeric" })}
            aria-current={d === today ? "date" : undefined}
            tabIndex={d === tabStop ? 0 : -1}
            onFocus={() => onFocusDay(d)}
            onClick={() => openDay(d)}
          >
            {d.endsWith("-01")
              ? formatDay(d, { month: "short", day: "numeric" })
              : Number(d.slice(8))}
          </button>
        </div>
      ))}
      {days.map((d, i) => (
        <DayWeather
          key={d}
          date={d}
          fit={weather}
          inMonth
          style={{ gridColumn: i + 1, gridRow: 1 }}
        />
      ))}
      {visible.map((s) => {
        const style: CSSProperties = {
          gridColumn: `${s.start + 1} / span ${s.span}`,
          gridRow: s.row + 2,
        };
        if ("task" in s) return <TaskChip key={taskKey(s.task)} task={s.task} style={style} />;
        return inAllDayBand(s.event) ? (
          <BarEvent
            key={eventKey(s.event)}
            event={s.event}
            calendar={lookup(s.event)}
            when={s.event.allDay ? "all day" : timeSpan(s.event, tz)}
            continuesBefore={s.continuesBefore}
            continuesAfter={s.continuesAfter}
            style={style}
          />
        ) : (
          <DotEvent
            key={eventKey(s.event)}
            event={s.event}
            calendar={lookup(s.event)}
            tz={tz}
            style={style}
          />
        );
      })}
      {more.map((n, i) =>
        n > 0 ? (
          <button
            key={days[i]}
            type="button"
            className="cal-month__more"
            style={{ gridColumn: i + 1, gridRow: Math.max(0, capacity - 1) + 2 }}
            onClick={() => openDay(days[i])}
          >
            {n} more
          </button>
        ) : null,
      )}
    </div>
  );
}

/** The same day of the month `n` months away, or that month's last day when it is shorter. */
function sameDayInMonth(day: string, n: number): string {
  const first = addMonths(day, n);
  const length = daysBetween(first, addMonths(first, 1));
  return addDays(first, Math.min(Number(day.slice(8)), length) - 1);
}

/**
 * Where a key pressed on a day button (class `dayClass`) of a grid of weeks moves the focus: arrows by day
 * and week, Home/End to the ends of the week, Page Up/Down by month. `null` for any other key or target.
 */
export function gridKeyStep(
  e: KeyboardEvent<HTMLElement>,
  dayClass: string,
  days: string[],
): { next: string; byMonth: boolean } | null {
  const target = e.target as HTMLElement;
  if (!target.classList.contains(dayClass) || e.altKey || e.ctrlKey || e.metaKey) return null;
  const day = target.closest<HTMLElement>("[data-date]")?.dataset.date;
  if (!day) return null;
  const col = days.indexOf(day) % 7;
  const by = (next: string, byMonth = false) => ({ next, byMonth });
  switch (e.key) {
    case "ArrowLeft":
      return by(addDays(day, -1));
    case "ArrowRight":
      return by(addDays(day, 1));
    case "ArrowUp":
      return by(addDays(day, -7));
    case "ArrowDown":
      return by(addDays(day, 7));
    case "Home":
      return by(addDays(day, -col));
    case "End":
      return by(addDays(day, 6 - col));
    case "PageUp":
      return by(sameDayInMonth(day, -1), true);
    case "PageDown":
      return by(sameDayInMonth(day, 1), true);
    default:
      return null;
  }
}

export function MonthGrid({
  days,
  anchor,
  tz,
  events,
}: {
  days: string[];
  anchor: string;
  tz: string;
  events: CalendarEvent[] | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const height = useHeight(ref);
  // Narrow days drop the start time before an event's title, so the title still reads.
  const width = useWidth(ref);
  const narrow = width > 0 && width / 7 < NARROW_DAY_PX;
  const weeks = Array.from({ length: days.length / 7 }, (_, w) => days.slice(w * 7, w * 7 + 7));
  // Rows that fit under the day number; before measuring, a typical window's worth.
  const weekHeight = height > 0 ? height / weeks.length : 120;
  const capacity = Math.max(1, Math.floor((weekHeight - MONTH_DATE_PX) / MONTH_ROW_PX));
  const today = dateOf(useNow(), tz);
  const month = anchor.slice(0, 7);
  const list = useMemo(() => events ?? [], [events]);
  const dated = useDatedTasks(days);
  // A task booked on a day shows as its block there, not as a chip too.
  const tasks = useMemo(() => withoutBooked(dated ?? [], list, tz), [dated, list, tz]);

  // Roving focus: one date button is in the tab order, the last one focused, else today, else the 1st.
  const gridRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const tabStop =
    focused && days.includes(focused) ? focused : days.includes(today) ? today : `${month}-01`;

  const focusDay = (day: string) => {
    const button = gridRef.current?.querySelector<HTMLElement>(
      `[data-date="${day}"] .cal-month__date`,
    );
    if (button) {
      pendingFocus.current = null;
      focusFromKeyboard(button);
      return true;
    }
    return false;
  };
  // A move past the edge changes the month first; focus the day once its grid is drawn.
  useEffect(() => {
    if (pendingFocus.current) focusDay(pendingFocus.current);
  }, [days]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = gridKeyStep(e, "cal-month__date", days);
    if (!step) return;
    const { next, byMonth } = step;
    e.preventDefault();
    setFocused(next);
    if (byMonth || !focusDay(next)) {
      pendingFocus.current = next;
      void useCalendarStore.getState().goTo(next, "month");
    }
  };

  const style = {
    "--cal-month-row-h": `${MONTH_ROW_PX}px`,
    "--cal-month-date-h": `${MONTH_DATE_PX}px`,
    "--cal-month-rows": capacity,
    "--cal-weeks": weeks.length,
  } as CSSProperties;

  return (
    <div
      className={cx("cal-month", narrow && "cal-month--narrow")}
      style={style}
      role="grid"
      aria-label="Calendar"
      ref={gridRef}
      onKeyDown={onKeyDown}
    >
      <div className="cal-month__head" role="row">
        {days.slice(0, 7).map((d) => (
          <div key={d} role="columnheader" className="cal-month__weekday">
            {formatDay(d, { weekday: "short" })}
          </div>
        ))}
      </div>
      <div className="cal-month__weeks" ref={ref}>
        {weeks.map((w) => (
          <Week
            key={w[0]}
            days={w}
            month={month}
            today={today}
            tabStop={tabStop}
            onFocusDay={setFocused}
            tz={tz}
            events={list}
            tasks={tasks}
            capacity={capacity}
            weather={weatherFit(width > 0 ? width / 7 : Infinity, WEATHER_FULL_PX, WEATHER_HIGH_PX)}
          />
        ))}
      </div>
    </div>
  );
}
