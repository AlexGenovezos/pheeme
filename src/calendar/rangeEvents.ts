import { useEffect, useState } from "react";
import { type CalendarEvent, getCalendarEvents } from "../lib/tauri";
import { displayZone, useCalendarStore } from "./calendarStore";
import { addDays, zonedMs } from "./dates";

/**
 * The shown calendars' events from `first` through `last` (dates in the display zone), read on
 * their own (the sidebar's agenda and mini month can show days the main view doesn't). Re-read
 * whenever the calendar's own events reload, which is how changes reach the screen. `null` until
 * the first read; a failed read keeps what was there.
 */
export function useRangeEvents(first: string, last: string): CalendarEvent[] | null {
  const accounts = useCalendarStore((s) => s.accounts);
  const version = useCalendarStore((s) => s.events);
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const tz = displayZone(accounts);
  const ready = accounts !== null;

  useEffect(() => {
    if (!ready) return;
    let stopped = false;
    getCalendarEvents(zonedMs(first, 0, tz), zonedMs(addDays(last, 1), 0, tz), tz)
      .then((list) => {
        if (!stopped) setEvents(list);
      })
      .catch((error) => console.warn("Could not read the sidebar's events", error));
    return () => {
      stopped = true;
    };
  }, [first, last, tz, ready, version]);

  return events;
}
