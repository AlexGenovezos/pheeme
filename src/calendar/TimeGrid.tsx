// Day and Week: day headers, the all-day band, then 24 hours with a time gutter, overlapping
// events side by side, and the current-time line on today.
import { type CSSProperties, useLayoutEffect, useMemo, useRef } from "react";
import type { CalendarEvent } from "../lib/tauri";
import { cx } from "../lib/utils";
import { useCalendarStore } from "./calendarStore";
import { formatDay, formatHour, wallClock } from "./dates";
import { createInColumn, createOnDays } from "./drag";
import { BarEvent, eventKey, TimedEventBlock, timeSpan, useCalendarLookup } from "./EventBlock";
import { layoutBand, layoutDay, MIN_EVENT_MINUTES } from "./layout";
import { useWidth } from "../lib/useWidth";
import { TaskChip, useDatedTasks } from "../tasks/DatedTasks";
import { layoutTasks } from "../tasks/gridLayout";
import { taskKey } from "../tasks/outline";
import { useNow } from "./useNow";

/** Height of one hour, in px. */
export const HOUR_PX = 48;
/** Height of one row in the all-day band, in px. */
export const BAND_ROW_PX = 26;
/** Blocks this short (minutes) show title and time on one line. */
const COMPACT_MINUTES = 45;
/** Narrower than this, an event shows only its title, edge to edge. */
const NARROW_EVENT_PX = 64;
/** The narrowest a day can be for two events side by side to still read. */
export const MIN_DAY_PX = NARROW_EVENT_PX;

/** The hour labels' column (--calendar-gutter-width). */
export function gutterWidth(): number {
  return (
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--calendar-gutter-width"),
    ) || 0
  );
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);

function DayHeader({ date, today, single }: { date: string; today: boolean; single: boolean }) {
  return (
    <div
      className={cx("cal-grid__day-head", today && "cal-grid__day-head--today")}
      role="columnheader"
    >
      <span className="cal-grid__weekday">{formatDay(date, { weekday: "short" })}</span>
      <button
        type="button"
        className="cal-grid__date"
        aria-label={formatDay(date, { weekday: "long", month: "long", day: "numeric" })}
        aria-current={today ? "date" : undefined}
        disabled={single}
        onClick={() => useCalendarStore.getState().goTo(date, "day")}
      >
        {Number(date.slice(8))}
      </button>
    </div>
  );
}

export function TimeGrid({
  days,
  tz,
  events,
}: {
  days: string[];
  tz: string;
  /** `null` while the first read is under way. */
  events: CalendarEvent[] | null;
}) {
  const lookup = useCalendarLookup();
  const now = wallClock(useNow(), tz);
  const scrollRef = useRef<HTMLDivElement>(null);
  const list = useMemo(() => events ?? [], [events]);

  const band = useMemo(() => layoutBand(list, days, tz), [list, days, tz]);
  const tasks = useDatedTasks(days);
  const taskBand = useMemo(() => layoutTasks(tasks ?? [], days, band), [tasks, days, band]);
  const bandRows = [...band, ...taskBand].reduce((n, s) => Math.max(n, s.row + 1), 0);
  const columns = useMemo(() => days.map((d) => layoutDay(list, d, tz)), [list, days, tz]);
  // Each day's width, for events too narrow for more than a few letters of their title.
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyWidth = useWidth(bodyRef);
  const dayWidth = bodyWidth > 0 ? (bodyWidth - gutterWidth()) / days.length : Infinity;

  // Open scrolled to the working day (an hour before now, when today is on screen), or to a pinned invitation.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const showsToday = days.includes(now.date);
    const reveal = useCalendarStore.getState().reveal;
    const minutes =
      reveal !== null
        ? Math.max(0, reveal - 60)
        : showsToday
          ? Math.max(0, now.minutes - 60)
          : 8 * 60;
    el.scrollTop = (minutes / 60) * HOUR_PX;
    // Only when the view opens; moving between weeks keeps the scroll position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const style = {
    "--cal-days": days.length,
    "--cal-hour-h": `${HOUR_PX}px`,
    "--cal-band-row-h": `${BAND_ROW_PX}px`,
    "--cal-band-rows": Math.max(1, bandRows),
  } as CSSProperties;

  return (
    <div
      className="cal-grid"
      style={style}
      role="grid"
      aria-label="Calendar"
      // Held invisible for the first (local) read, so the all-day band doesn't grow under the user.
      data-loading={events === null || tasks === null || undefined}
    >
      <div className="cal-grid__head" role="row">
        <div className="cal-grid__gutter cal-grid__zone" title={tz}>
          {zoneAbbreviation(tz)}
        </div>
        {days.map((d) => (
          <DayHeader key={d} date={d} today={d === now.date} single={days.length === 1} />
        ))}
      </div>
      <div className="cal-grid__band" role="row" aria-label="All-day events">
        <div className="cal-grid__gutter" />
        <div className="cal-grid__band-cells">
          {days.map((d, i) => (
            <div
              key={d}
              className="cal-grid__band-cell"
              style={{ gridColumn: i + 1 }}
              data-cal-drop="day"
              data-date={d}
              onPointerDown={(e) => createOnDays(e, d)}
            />
          ))}
          {band.map((s) => (
            <BarEvent
              key={eventKey(s.event)}
              event={s.event}
              calendar={lookup(s.event)}
              when={s.event.allDay ? "all day" : timeSpan(s.event, tz)}
              continuesBefore={s.continuesBefore}
              continuesAfter={s.continuesAfter}
              style={{ gridColumn: `${s.start + 1} / span ${s.span}`, gridRow: s.row + 1 }}
            />
          ))}
          {taskBand.map((s) => (
            <TaskChip
              key={taskKey(s.task)}
              task={s.task}
              style={{ gridColumn: s.start + 1, gridRow: s.row + 1 }}
            />
          ))}
        </div>
      </div>
      <div className="cal-grid__scroll" ref={scrollRef}>
        <div className="cal-grid__body" ref={bodyRef}>
          <div className="cal-grid__gutter cal-grid__hours" aria-hidden="true">
            {HOURS.map((h) => (
              <span key={h} className="cal-grid__hour" style={{ top: h * HOUR_PX }}>
                {h === 0 ? "" : formatHour(h)}
              </span>
            ))}
          </div>
          {days.map((d, i) => (
            <div
              key={d}
              className={cx("cal-grid__column", d === now.date && "cal-grid__column--today")}
              role="gridcell"
              aria-label={formatDay(d, { weekday: "long", month: "long", day: "numeric" })}
              data-cal-drop="time"
              data-date={d}
              onPointerDown={(e) => createInColumn(e, d, tz)}
            >
              {columns[i].map((b) => {
                const shown = Math.max(b.end - b.start, MIN_EVENT_MINUTES);
                return (
                  <TimedEventBlock
                    key={eventKey(b.event)}
                    event={b.event}
                    calendar={lookup(b.event)}
                    tz={tz}
                    compact={shown < COMPACT_MINUTES}
                    narrow={(dayWidth * b.span) / b.columns < NARROW_EVENT_PX}
                    style={{
                      top: (b.start / 60) * HOUR_PX,
                      height: (shown / 60) * HOUR_PX,
                      left: `${(b.column / b.columns) * 100}%`,
                      // A sliver stays free at the column's right edge, for clicking the grid
                      // behind; events side by side keep only a hairline gap between them.
                      width: `calc(${(b.span / b.columns) * 100}% - ${
                        b.column + b.span === b.columns ? "var(--space-2)" : "var(--space-0-5)"
                      })`,
                    }}
                  />
                );
              })}
              {d === now.date && (
                <div
                  className="cal-grid__now"
                  style={{ top: (now.minutes / 60) * HOUR_PX }}
                  aria-hidden="true"
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** "EST"-style name of the zone, or the offset ("GMT+1") where there's no short name. */
function zoneAbbreviation(tz: string): string {
  const part = new Intl.DateTimeFormat(undefined, { timeZone: tz, timeZoneName: "short" })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? "";
}
