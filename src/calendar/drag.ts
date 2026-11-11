// Dragging on the grid, as on the website: sweep empty hours or days to place a new event (a
// click places an hour, or a day), drag an event to move it (across days in Week, day to day in
// Month), and drag a timed event's bottom edge to change when it ends. Times snap to 15 minutes.
// Escape cancels. Drop targets are marked `data-cal-drop="time" | "day"` with `data-date`.
import type { PointerEvent as ReactPointerEvent } from "react";
import type { CalendarEvent, EventTime } from "../lib/tauri";
import { cancelDraft, moveEvent, startDraft } from "./actions";
import { addDays, daysBetween, wallClock, zonedMs } from "./dates";
import { DRAFT_ID, useEditStore } from "./editStore";
import { eventKey } from "./EventBlock";

const DAY_MINUTES = 24 * 60;
const SNAP = 15;
/** Pointer travel (px) before a press becomes a drag. */
const THRESHOLD = 4;

// ── Telling clicks from drags ────────────────────────────────────────────────

let swallowClick = false;
/** True once, for the click that ends a drag (so dropping an event doesn't also open it). */
export function consumeDragClick(): boolean {
  const was = swallowClick;
  swallowClick = false;
  return was;
}

let dismissedBy: Event | null = null;
/** A popover closed on this press: the grid mustn't also start a new event with it. */
export const noteDismiss = (e: Event) => {
  dismissedBy = e;
};

function track(
  e: ReactPointerEvent,
  h: {
    move(x: number, y: number): void;
    end(dragged: boolean): void;
    cancel(): void;
  },
) {
  const x0 = e.clientX;
  const y0 = e.clientY;
  let dragged = false;
  const onMove = (ev: PointerEvent) => {
    if (!dragged && Math.hypot(ev.clientX - x0, ev.clientY - y0) < THRESHOLD) return;
    dragged = true;
    h.move(ev.clientX, ev.clientY);
  };
  const onUp = () => {
    stop();
    if (dragged) {
      swallowClick = true;
      setTimeout(() => (swallowClick = false), 0);
    }
    h.end(dragged);
  };
  const onCancel = () => {
    stop();
    h.cancel();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    onCancel();
  };
  const stop = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, true);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey, true);
}

/** A press that may start a drag: the main button, not one that just closed a popover. */
function pressable(e: ReactPointerEvent): boolean {
  if (e.button !== 0 || e.ctrlKey || e.metaKey) return false;
  if (dismissedBy === e.nativeEvent) return false;
  return true;
}

// ── Where the pointer is ─────────────────────────────────────────────────────

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Minutes past midnight at `y` in a day column (its height is the whole day). */
function minutesIn(column: HTMLElement, y: number): number {
  const rect = column.getBoundingClientRect();
  if (rect.height <= 0) return 0;
  return clamp(((y - rect.top) / rect.height) * DAY_MINUTES, 0, DAY_MINUTES);
}

/** The drop target of `kind` under the point. */
function targetAt(x: number, y: number, kind: "time" | "day"): HTMLElement | null {
  const stack = document.elementsFromPoint?.(x, y) ?? [];
  for (const el of stack)
    if (el instanceof HTMLElement && el.dataset.calDrop === kind && el.dataset.date) return el;
  return null;
}

const snap = (minutes: number, step = SNAP) => Math.round(minutes / step) * step;

// ── New events ───────────────────────────────────────────────────────────────

/** Press on an empty part of a day column: sweep out a new event, or click for an hour. */
export function createInColumn(e: ReactPointerEvent<HTMLElement>, date: string, tz: string) {
  if (e.target !== e.currentTarget || !pressable(e)) return;
  const column = e.currentTarget;
  const from = minutesIn(column, e.clientY);
  const at = (a: number, b: number) => {
    const start = clamp(Math.floor(Math.min(a, b) / SNAP) * SNAP, 0, DAY_MINUTES - SNAP);
    const end = clamp(
      Math.max(Math.ceil(Math.max(a, b) / SNAP) * SNAP, start + SNAP),
      0,
      DAY_MINUTES,
    );
    return { allDay: false, start: zonedMs(date, start, tz), end: zonedMs(date, end, tz) };
  };
  track(e, {
    move: (_x, y) => void startDraft(at(from, minutesIn(column, y)), "dragging"),
    end: (dragged) => {
      if (!dragged) {
        // A click: an hour from the half hour clicked.
        const start = Math.min(Math.floor(from / 30) * 30, DAY_MINUTES - 60);
        startDraft({
          allDay: false,
          start: zonedMs(date, start, tz),
          end: zonedMs(date, start + 60, tz),
        });
        return;
      }
      useEditStore.setState((s) => (s.draft ? { draft: { ...s.draft, phase: "ready" } } : {}));
    },
    cancel: cancelDraft,
  });
}

/** Press on an empty day (all-day band, month cell): sweep across days, or click for one. */
export function createOnDays(e: ReactPointerEvent<HTMLElement>, date: string) {
  if (e.target !== e.currentTarget || !pressable(e)) return;
  let last = date;
  const days = () =>
    last < date ? { startDate: last, endDate: date } : { startDate: date, endDate: last };
  track(e, {
    move: (x, y) => {
      last = targetAt(x, y, "day")?.dataset.date ?? last;
      startDraft({ allDay: true, ...days() }, "dragging");
    },
    end: (dragged) => {
      if (!dragged) {
        startDraft({ allDay: true, startDate: date, endDate: date });
        return;
      }
      useEditStore.setState((s) => (s.draft ? { draft: { ...s.draft, phase: "ready" } } : {}));
    },
    cancel: cancelDraft,
  });
}

// ── Moving and resizing ──────────────────────────────────────────────────────

/** The event `delta` days later, keeping its wall-clock times in `tz`. */
export function shiftDays(
  event: CalendarEvent,
  delta: number,
  tz: string,
): { start: EventTime; end: EventTime } {
  if (event.allDay)
    return {
      start: { ...event.start, date: event.start.date && addDays(event.start.date, delta) },
      end: { ...event.end, date: event.end.date && addDays(event.end.date, delta) },
    };
  const move = (ms: number | null) => {
    if (ms == null) return null;
    const w = wallClock(ms, tz);
    return zonedMs(addDays(w.date, delta), w.minutes, tz);
  };
  return {
    start: { ...event.start, ms: move(event.start.ms) },
    end: { ...event.end, ms: move(event.end.ms) },
  };
}

const sameTime = (a: EventTime, b: EventTime) => a.ms === b.ms && a.date === b.date;

function drop(event: CalendarEvent, dragged: boolean) {
  const moving = useEditStore.getState().moving;
  const key = eventKey(event);
  if (
    dragged &&
    moving?.key === key &&
    !(sameTime(moving.start, event.start) && sameTime(moving.end, event.end))
  ) {
    void moveEvent(event, moving.start, moving.end);
    return;
  }
  if (moving?.key === key) useEditStore.setState({ moving: null });
}

const editable = (event: CalendarEvent) => event.canEdit && event.id !== DRAFT_ID;

/**
 * Press on a timed block in Day or Week: drag it to another time or day, or (from its bottom
 * edge, `.cal-event__resize`) drag its end.
 */
export function dragTimed(e: ReactPointerEvent<HTMLElement>, event: CalendarEvent, tz: string) {
  if (!editable(event) || !pressable(e) || event.start.ms == null) return;
  const startMs = event.start.ms;
  const endMs = Math.max(event.end.ms ?? startMs, startMs);
  const resizing = (e.target as HTMLElement).closest(".cal-event__resize") != null;
  const column = e.currentTarget.closest<HTMLElement>('[data-cal-drop="time"]');
  if (!column?.dataset.date) return;
  // Where on the event it was grabbed, so it doesn't jump to put its top under the pointer.
  const grab = zonedMs(column.dataset.date, minutesIn(column, e.clientY), tz) - startMs;
  const key = eventKey(event);
  track(e, {
    move: (x, y) => {
      const target = targetAt(x, y, "time");
      if (!target) return;
      const at = zonedMs(target.dataset.date!, minutesIn(target, y), tz);
      if (resizing) {
        const w = wallClock(at, tz);
        const end = Math.max(zonedMs(w.date, snap(w.minutes), tz), startMs + SNAP * 60_000);
        useEditStore.setState({
          moving: { key, start: event.start, end: { ...event.end, ms: end } },
        });
        return;
      }
      const w = wallClock(at - grab, tz);
      const start = zonedMs(w.date, snap(w.minutes), tz);
      useEditStore.setState({
        moving: {
          key,
          start: { ...event.start, ms: start },
          end: { ...event.end, ms: start + (endMs - startMs) },
        },
      });
    },
    end: (dragged) => drop(event, dragged),
    cancel: () => useEditStore.setState({ moving: null }),
  });
}

/** Press on a bar (all-day band, month cell) or a month line: drag it to other days. */
export function dragOnDays(e: ReactPointerEvent<HTMLElement>, event: CalendarEvent, tz: string) {
  if (!editable(event) || !pressable(e)) return;
  const from = targetAt(e.clientX, e.clientY, "day")?.dataset.date;
  if (!from) return;
  const key = eventKey(event);
  track(e, {
    move: (x, y) => {
      const over = targetAt(x, y, "day")?.dataset.date;
      if (!over) return;
      useEditStore.setState({ moving: { key, ...shiftDays(event, daysBetween(from, over), tz) } });
    },
    end: (dragged) => drop(event, dragged),
    cancel: () => useEditStore.setState({ moving: null }),
  });
}
