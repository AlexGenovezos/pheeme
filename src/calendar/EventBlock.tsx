// How one event draws: a timed block in Day/Week, a bar in the all-day band or a month cell, or a
// dot-and-time line for a short event in a month cell. Declined events are struck through and
// dimmed; unanswered invites are dashed, as on the website. Events you can change can be dragged
// (see `drag.ts`); the new event being placed draws here too, but can't be clicked. Google's task
// block for a task Pheeme has shows as that task: a round tick before its title, struck through
// once it's done (the tick sits beside the block's button, over its corner, as buttons don't nest).
import { Clock, MapPin, Video } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, type CSSProperties, type MouseEvent } from "react";
import type { CalendarEvent, CalendarInfo } from "../lib/tauri";
import { cx } from "../lib/utils";
import { displayZone, useCalendarStore } from "./calendarStore";
import { eventColors } from "./colors";
import { formatTime } from "./dates";
import { consumeDragClick, dragOnDays, dragTimed } from "./drag";
import { DRAFT_ID, useEditStore } from "./editStore";
import { TaskTick, useBlockTask } from "../tasks/DatedTasks";
import type { Task } from "../lib/tauri";

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

/** Response classes shared by every shape, and the editing ones; a task block's too. */
function responseClass(e: CalendarEvent, task?: Task) {
  return cx(
    task && "cal-event--task",
    task?.completed && "cal-event--task-done",
    e.selfResponse === "declined" && "cal-event--declined",
    e.selfResponse === "needsAction" && "cal-event--invite",
    e.selfResponse === "tentative" && "cal-event--tentative",
    e.id === DRAFT_ID && "cal-event--draft",
    e.canEdit && "cal-event--editable",
  );
}

/** Being dragged, or saved at a new time. */
const useMoving = (event: CalendarEvent) => useEditStore((s) => eventKey(event) in s.moving);

function openFrom(event: CalendarEvent) {
  return (e: MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    if (consumeDragClick() || event.id === DRAFT_ID) return;
    useCalendarStore.getState().openEvent({ event, anchor: e.currentTarget });
  };
}

const useZone = () => displayZone(useCalendarStore((s) => s.accounts));

/** The title, after a camera when the event has a video call to join. */
function Title({ event }: { event: CalendarEvent }) {
  return (
    <span className="cal-event__title">
      {event.meeting && <Video className="cal-event__call" aria-hidden="true" />}
      {eventTitle(event)}
    </span>
  );
}

/** Words for screen readers: title, when, the call, and the answer if it matters. */
function accessibleName(e: CalendarEvent, when: string, task?: Task) {
  const answer =
    e.selfResponse === "declined"
      ? ", declined"
      : e.selfResponse === "needsAction"
        ? ", not answered"
        : e.selfResponse === "tentative"
          ? ", maybe"
          : "";
  const call = e.meeting ? ", video call" : "";
  const done = task?.completed ? ", done" : "";
  return `${eventTitle(e)}, ${when}${call}${answer}${done}`;
}

export function TimedEventBlock({
  event,
  calendar,
  tz,
  style,
  compact,
  narrow = false,
  stacked = false,
  clearHeight = Infinity,
}: {
  event: CalendarEvent;
  calendar: CalendarInfo | undefined;
  tz: string;
  style: CSSProperties;
  /** Too short for a second line. */
  compact: boolean;
  /** Tighter padding; short blocks omit the inline time. */
  narrow?: boolean;
  /** A tall, slim block has room for a title and distinct detail groups. */
  stacked?: boolean;
  /** Uncovered space above the first foreground card, in pixels. */
  clearHeight?: number;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const button = ref.current!;
    const content = contentRef.current!;
    const measure = () => {
      // A card with lines to spare wraps its title over them, keeping one for each detail.
      if (!compact && !stacked) {
        const title = content.querySelector<HTMLElement>(".cal-event__title")!;
        const box = getComputedStyle(button);
        const room =
          button.clientHeight - parseFloat(box.paddingTop) - parseFloat(box.paddingBottom);
        const lines =
          Math.floor(room / parseFloat(getComputedStyle(title).lineHeight)) -
          content.querySelectorAll(".cal-event__detail").length;
        if (lines > 1) {
          button.dataset.titleLines = "";
          button.style.setProperty("--cal-event-title-lines", String(lines));
        } else delete button.dataset.titleLines;
      } else delete button.dataset.titleLines;
      // Measure the full-width text first, regardless of hover/focus or the previous width.
      content.style.maxWidth = "100%";
      const bottom = content.getBoundingClientRect().bottom - button.getBoundingClientRect().top;
      button.style.setProperty(
        "--cal-event-text-width",
        bottom > clearHeight ? "var(--cal-event-content-width)" : "100%",
      );
      content.style.removeProperty("max-width");
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(button);
    document.fonts?.addEventListener("loadingdone", measure);
    return () => {
      observer?.disconnect();
      document.fonts?.removeEventListener("loadingdone", measure);
    };
  }, [clearHeight, event, compact, narrow, stacked]);
  const { background, text } = eventColors(event, calendar);
  const when = timeSpan(event, tz);
  const open = useCalendarStore((s) => s.open && eventKey(s.open.event) === eventKey(event));
  const moving = useMoving(event);
  const task = useBlockTask(event);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={cx(
          "cal-event cal-event--timed",
          compact && "cal-event--compact",
          narrow && "cal-event--narrow",
          stacked && "cal-event--stacked",
          (open || moving) && "cal-event--open",
          responseClass(event, task),
        )}
        style={{ ...style, "--cal-event-bg": background, "--cal-event-fg": text } as CSSProperties}
        aria-label={accessibleName(event, when, task)}
        title={[eventTitle(event), when, event.location].filter(Boolean).join("\n")}
        aria-haspopup="dialog"
        data-event-key={eventKey(event)}
        onClick={openFrom(event)}
        onPointerDown={(e) => dragTimed(e, event, tz)}
      >
        <span ref={contentRef} className="cal-event__content">
          <Title event={event} />
          {compact ? (
            !narrow && <span className="cal-event__time">, {when.split(" – ")[0]}</span>
          ) : narrow && !stacked ? null : (
            <span className="cal-event__details">
              <span className="cal-event__time cal-event__detail">
                <Clock className="cal-event__detail-icon" aria-hidden="true" />
                <span className="cal-event__range">
                  {when.split(" – ").map((time, i) => (
                    <span key={i}>
                      {i > 0 && " – "}
                      {time}
                    </span>
                  ))}
                </span>
              </span>
              {event.location && (
                <span className="cal-event__location cal-event__detail">
                  <MapPin className="cal-event__detail-icon" aria-hidden="true" />
                  <span>{event.location}</span>
                </span>
              )}
            </span>
          )}
        </span>
        {event.canEdit && <span className="cal-event__resize" aria-hidden="true" />}
      </button>
      {task && (
        <TaskTick
          task={task}
          className="cal-event-tick cal-event-tick--timed"
          style={{ top: style.top, left: style.left }}
        />
      )}
    </>
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
      <Title event={event} />
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
  const task = useBlockTask(event);
  return (
    <>
      <button
        type="button"
        className={cx("cal-event cal-event--dot", responseClass(event, task))}
        style={{ ...style, "--cal-event-bg": background } as CSSProperties}
        aria-label={accessibleName(event, timeSpan(event, tz), task)}
        aria-haspopup="dialog"
        data-event-key={eventKey(event)}
        onClick={openFrom(event)}
        onPointerDown={(e) => dragOnDays(e, event, tz)}
      >
        <span className="cal-event__dot" aria-hidden="true" />
        <span className="cal-event__time">{start}</span>
        <Title event={event} />
      </button>
      {task && (
        <TaskTick
          task={task}
          className="cal-event-tick cal-event-tick--dot"
          style={{ gridColumn: style.gridColumn, gridRow: style.gridRow }}
        />
      )}
    </>
  );
}
