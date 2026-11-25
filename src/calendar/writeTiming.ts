// Times a calendar change the way the user waits for it: from their last answer (Save, Delete, the drop) to
// Google's confirmation reaching the window, then to the calendar painted with it. Sent to the diagnostics
// log (`log_calendar_write`), beside the backend's own line, which splits the write into Google's time and
// Pheeme's.
import { type CalendarWriteShown, type EditScope, logCalendarWrite } from "../lib/tauri";

export interface WriteTimer {
  /** Google confirmed the change; the redraw starts now. */
  wrote(): void;
  /** The calendar shows it, couldn't be read again, or the write failed. Reports once. */
  done(outcome: CalendarWriteShown["outcome"]): void;
}

/** Runs `f` once the frame with the latest state has painted (the next frame, then the task after it). */
function afterPaint(f: () => void) {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(f, 0));
  else setTimeout(f, 0);
}

export function timeWrite(
  op: CalendarWriteShown["op"],
  scope: EditScope | null = null,
  now: () => number = () => performance.now(),
  report: (r: CalendarWriteShown) => unknown = logCalendarWrite,
  painted: (f: () => void) => void = afterPaint,
): WriteTimer {
  const started = now();
  let wroteAt: number | null = null;
  let reported = false;
  const send = (outcome: CalendarWriteShown["outcome"]) => {
    const end = now();
    const ms = (n: number) => Math.round(n);
    // The log is a side channel: a failure to write it must not touch the change.
    try {
      void Promise.resolve(
        report({
          op,
          scope,
          outcome,
          writeMs: ms((wroteAt ?? end) - started),
          redrawMs: outcome === "shown" && wroteAt !== null ? ms(end - wroteAt) : null,
          totalMs: ms(end - started),
        }),
      ).catch(() => {});
    } catch {
      // As above.
    }
  };
  return {
    wrote() {
      wroteAt ??= now();
    },
    done(outcome) {
      if (reported) return;
      reported = true;
      // Shown means painted: measured after the frame, without holding up the action.
      if (outcome === "shown") painted(() => send(outcome));
      else send(outcome);
    },
  };
}
