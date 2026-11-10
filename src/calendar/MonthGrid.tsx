// Month: whole weeks of day cells. Bars for all-day and multi-day events, a dot line for each
// shorter one, and "+N more" where a day has more than fits. Clicking a day opens it in Day view.
import { type CSSProperties, useMemo, useRef } from "react";
import type { CalendarEvent } from "../lib/tauri";
import { useHeight } from "../lib/useWidth";
import { cx } from "../lib/utils";
import { useCalendarStore } from "./calendarStore";
import { dateOf, formatDay } from "./dates";
import { BarEvent, DotEvent, eventKey, timeSpan, useCalendarLookup } from "./EventBlock";
import { fitRows, inAllDayBand, layoutBand } from "./layout";
import { useNow } from "./useNow";

/** One event line in a cell, in px. */
export const MONTH_ROW_PX = 22;
/** The day number at the top of a cell, in px. */
export const MONTH_DATE_PX = 28;

function Week({
  days,
  month,
  today,
  tz,
  events,
  capacity,
}: {
  days: string[];
  month: string;
  today: string;
  tz: string;
  events: CalendarEvent[];
  capacity: number;
}) {
  const lookup = useCalendarLookup();
  const { visible, more } = useMemo(
    () => fitRows(layoutBand(events, days, tz, true), days.length, capacity),
    [events, days, tz, capacity],
  );
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
        >
          <button
            type="button"
            className="cal-month__date"
            aria-label={formatDay(d, { weekday: "long", month: "long", day: "numeric" })}
            aria-current={d === today ? "date" : undefined}
            onClick={() => openDay(d)}
          >
            {d.endsWith("-01")
              ? formatDay(d, { month: "short", day: "numeric" })
              : Number(d.slice(8))}
          </button>
        </div>
      ))}
      {visible.map((s) => {
        const style: CSSProperties = {
          gridColumn: `${s.start + 1} / span ${s.span}`,
          gridRow: s.row + 2,
        };
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
  const weeks = Array.from({ length: days.length / 7 }, (_, w) => days.slice(w * 7, w * 7 + 7));
  // Rows that fit under the day number; before measuring, a typical window's worth.
  const weekHeight = height > 0 ? height / weeks.length : 120;
  const capacity = Math.max(1, Math.floor((weekHeight - MONTH_DATE_PX) / MONTH_ROW_PX));
  const today = dateOf(useNow(), tz);
  const month = anchor.slice(0, 7);
  const list = useMemo(() => events ?? [], [events]);

  const style = {
    "--cal-month-row-h": `${MONTH_ROW_PX}px`,
    "--cal-month-date-h": `${MONTH_DATE_PX}px`,
    "--cal-month-rows": capacity,
    "--cal-weeks": weeks.length,
  } as CSSProperties;

  return (
    <div className="cal-month" style={style} role="grid" aria-label="Calendar">
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
            tz={tz}
            events={list}
            capacity={capacity}
          />
        ))}
      </div>
    </div>
  );
}
