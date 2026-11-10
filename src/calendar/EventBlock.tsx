// How one event draws: a timed block in Day/Week, a bar in the all-day band or a month cell, or a
// dot-and-time line for a short event in a month cell. Declined events are struck through and
// dimmed; unanswered invites are dashed, as on the website. Events you can change can be dragged
// (see `drag.ts`); the new event being placed draws here too, but can't be clicked.
import { useMemo, type CSSProperties, type MouseEvent } from "react";
import type { CalendarEvent, CalendarInfo } from "../lib/tauri";
import { cx } from "../lib/utils";
import { displayZone, useCalendarStore } from "./calendarStore";
import { eventColors } from "./colors";
import { formatTime } from "./dates";
import { consumeDragClick, dragOnDays, dragTimed } from "./drag";
import { DRAFT_ID, useEditStore } from "./editStore";

export const eventKey = (e: CalendarEvent) => `${e.accountId}\n${e.calendarId}\n${e.id}`;

export const eventTitle = (e: CalendarEvent) => e.summary?.trim() || "(No title)";

/** Every calendar by account and id, for colours. */
export function useCalendarLookup(): (e: CalendarEvent) => CalendarInfo | undefined {
  const accounts = useCalendarStore((s) => s.accounts);
  return useMemo(() => {
    const map = new Map<string, CalendarInfo>();
    for (const a of accounts ?? [])
      for (const c of a.calendars) map.set(`${a.accountId}\n${c.id}`, c);
    return (e) => map.get(`${e.accountId}\n${e.calendarId}`);
  }, [accounts]);
}

/** "2:30 – 3:30 PM"-style span of a timed event. */
export function timeSpan(e: CalendarEvent, tz: string): string {
  if (e.start.ms == null) return "";
  const start = formatTime(e.start.ms, tz);
  if (e.end.ms == null || e.end.ms === e.start.ms) return start;
  return `${start} – ${formatTime(e.end.ms, tz)}`;
}

/** Response classes shared by every shape, and the editing ones. */
function responseClass(e: CalendarEvent) {
  return cx(
    e.selfResponse === "declined" && "cal-event--declined",
    e.selfResponse === "needsAction" && "cal-event--invite",
    e.selfResponse === "tentative" && "cal-event--tentative",
    e.id === DRAFT_ID && "cal-event--draft",
    e.canEdit && "cal-event--editable",
  );
}

/** Being dragged, or saved at a new time. */
const useMoving = (event: CalendarEvent) => useEditStore((s) => s.moving?.key === eventKey(event));

function openFrom(event: CalendarEvent) {
  return (e: MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    if (consumeDragClick() || event.id === DRAFT_ID) return;
    useCalendarStore.getState().openEvent({ event, anchor: e.currentTarget });
  };
}

const useZone = () => displayZone(useCalendarStore((s) => s.accounts));

/** Words for screen readers: title, when, and the answer if it matters. */
function accessibleName(e: CalendarEvent, when: string) {
  const answer =
    e.selfResponse === "declined"
      ? ", declined"
      : e.selfResponse === "needsAction"
        ? ", not answered"
        : e.selfResponse === "tentative"
          ? ", maybe"
          : "";
  return `${eventTitle(e)}, ${when}${answer}`;
}

export function TimedEventBlock({
  event,
  calendar,
  tz,
  style,
  compact,
}: {
  event: CalendarEvent;
  calendar: CalendarInfo | undefined;
  tz: string;
  style: CSSProperties;
  /** Too short for a second line. */
  compact: boolean;
}) {
  const { background, text } = eventColors(event, calendar);
  const when = timeSpan(event, tz);
  const open = useCalendarStore((s) => s.open && eventKey(s.open.event) === eventKey(event));
  const moving = useMoving(event);
  return (
    <button
      type="button"
      className={cx(
        "cal-event cal-event--timed",
        compact && "cal-event--compact",
        (open || moving) && "cal-event--open",
        responseClass(event),
      )}
      style={{ ...style, "--cal-event-bg": background, "--cal-event-fg": text } as CSSProperties}
      aria-label={accessibleName(event, when)}
      aria-haspopup="dialog"
      data-event-key={eventKey(event)}
      onClick={openFrom(event)}
      onPointerDown={(e) => dragTimed(e, event, tz)}
    >
      <span className="cal-event__title">{eventTitle(event)}</span>
      {compact ? (
        <span className="cal-event__time">, {when.split(" – ")[0]}</span>
      ) : (
        <>
          <span className="cal-event__time">{when}</span>
          {event.location && <span className="cal-event__location">{event.location}</span>}
        </>
      )}
      {event.canEdit && <span className="cal-event__resize" aria-hidden="true" />}
    </button>
  );
}

/** A bar across days (all-day band, month cells). */
export function BarEvent({
  event,
  calendar,
  style,
  continuesBefore,
  continuesAfter,
  when,
}: {
  event: CalendarEvent;
  calendar: CalendarInfo | undefined;
  style: CSSProperties;
  continuesBefore: boolean;
  continuesAfter: boolean;
  when: string;
}) {
  const { background, text } = eventColors(event, calendar);
  const tz = useZone();
  const moving = useMoving(event);
  return (
    <button
      type="button"
      className={cx(
        "cal-event cal-event--bar",
        continuesBefore && "cal-event--continues-before",
        continuesAfter && "cal-event--continues-after",
        moving && "cal-event--open",
        responseClass(event),
      )}
      style={{ ...style, "--cal-event-bg": background, "--cal-event-fg": text } as CSSProperties}
      aria-label={accessibleName(event, when)}
      aria-haspopup="dialog"
      data-event-key={eventKey(event)}
      onClick={openFrom(event)}
      onPointerDown={(e) => dragOnDays(e, event, tz)}
    >
      <span className="cal-event__title">{eventTitle(event)}</span>
    </button>
  );
}

/** A short timed event in a month cell: a dot in its colour, the start time and the title. */
export function DotEvent({
  event,
  calendar,
  tz,
  style,
}: {
  event: CalendarEvent;
  calendar: CalendarInfo | undefined;
  tz: string;
  style: CSSProperties;
}) {
  const { background } = eventColors(event, calendar);
  const start = event.start.ms != null ? formatTime(event.start.ms, tz) : "";
  return (
    <button
      type="button"
      className={cx("cal-event cal-event--dot", responseClass(event))}
      style={{ ...style, "--cal-event-bg": background } as CSSProperties}
      aria-label={accessibleName(event, timeSpan(event, tz))}
      aria-haspopup="dialog"
      data-event-key={eventKey(event)}
      onClick={openFrom(event)}
      onPointerDown={(e) => dragOnDays(e, event, tz)}
    >
      <span className="cal-event__dot" aria-hidden="true" />
      <span className="cal-event__time">{start}</span>
      <span className="cal-event__title">{eventTitle(event)}</span>
    </button>
  );
}
