// The sidebar's agenda: what's left of today, then the next two days, as a list (like a paper
// diary's page), so the sidebar shows your days rather than only settings.
import { type CSSProperties, type MouseEvent, useMemo } from "react";
import { Skeleton } from "../components/ui/Skeleton";
import type { CalendarEvent } from "../lib/tauri";
import { cx } from "../lib/utils";
import { displayZone, useCalendarStore } from "./calendarStore";
import { eventColors } from "./colors";
import { addDays, dateOf, formatDay } from "./dates";
import { eventKey, eventTitle, timeSpan, useCalendarLookup } from "./EventBlock";
import { eventDays, inAllDayBand } from "./layout";
import { useRangeEvents } from "./rangeEvents";
import { useNow } from "./useNow";

/** Today and the two days after it. */
const DAYS = 3;

export function SidebarAgenda() {
  const accounts = useCalendarStore((s) => s.accounts);
  const tz = displayZone(accounts);
  const now = useNow();
  const today = dateOf(now, tz);
  const last = addDays(today, DAYS - 1);
  const events = useRangeEvents(today, last);
  const lookup = useCalendarLookup();

  const days = useMemo(() => {
    const out: { date: string; allDay: CalendarEvent[]; timed: CalendarEvent[] }[] = [];
    for (let i = 0; i < DAYS; i++) out.push({ date: addDays(today, i), allDay: [], timed: [] });
    for (const e of events ?? []) {
      if (e.selfResponse === "declined") continue;
      const span = eventDays(e, tz);
      if (!span) continue;
      for (const day of out) {
        if (day.date < span.first || day.date > span.last) continue;
        if (inAllDayBand(e)) day.allDay.push(e);
        // Today: only what hasn't ended yet.
        else if (day.date !== today || (e.end.ms ?? 0) > now) day.timed.push(e);
      }
    }
    for (const day of out) day.timed.sort((a, b) => (a.start.ms ?? 0) - (b.start.ms ?? 0));
    return out;
  }, [events, today, tz, now]);

  const open = (e: CalendarEvent, date: string) => (ev: MouseEvent<HTMLButtonElement>) => {
    const store = useCalendarStore.getState();
    store.goTo(date);
    store.openEvent({ event: e, anchor: ev.currentTarget });
  };

  return (
    <section className="cal-agenda" aria-label="Agenda">
      {days.map((day, i) => {
        const nextUp = i === 0 ? day.timed.find((e) => (e.start.ms ?? 0) > now) : undefined;
        return (
          <div key={day.date} className="cal-agenda__day">
            <h2 className="cal-agenda__date">
              <span className={cx(i === 0 && "cal-agenda__today")}>
                {i === 0
                  ? "Today"
                  : i === 1
                    ? "Tomorrow"
                    : formatDay(day.date, { weekday: "long" })}
              </span>
              <span className="cal-agenda__date-sub">
                {formatDay(day.date, { month: "short", day: "numeric" })}
              </span>
            </h2>
            {events === null ? (
              <div className="cal-agenda__row" aria-hidden="true">
                <span className="cal-agenda__dot" />
                <span className="cal-agenda__text">
                  <Skeleton width="45%" />
                  <Skeleton width="75%" />
                </span>
              </div>
            ) : day.allDay.length + day.timed.length === 0 ? (
              <p className="cal-agenda__empty">
                {i === 0 ? "Nothing else today" : "Nothing planned"}
              </p>
            ) : (
              <ul className="cal-agenda__list">
                {day.allDay.map((e) => {
                  const { background } = eventColors(e, lookup(e));
                  return (
                    <li key={eventKey(e)}>
                      <button
                        type="button"
                        className="cal-agenda__pill"
                        style={{ "--cal-event-bg": background } as CSSProperties}
                        onClick={open(e, day.date)}
                      >
                        {eventTitle(e)}
                      </button>
                    </li>
                  );
                })}
                {day.timed.map((e) => {
                  const { background } = eventColors(e, lookup(e));
                  return (
                    <li key={eventKey(e)}>
                      <button
                        type="button"
                        className="cal-agenda__row"
                        style={{ "--cal-event-bg": background } as CSSProperties}
                        onClick={open(e, day.date)}
                      >
                        <span className="cal-agenda__dot" aria-hidden="true" />
                        <span className="cal-agenda__text">
                          {e === nextUp && <span className="cal-agenda__next">Up next</span>}
                          <span className="cal-agenda__time">{timeSpan(e, tz)}</span>
                          <span className="cal-agenda__title">{eventTitle(e)}</span>
                          {e.location && <span className="cal-agenda__place">{e.location}</span>}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </section>
  );
}
