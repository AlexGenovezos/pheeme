// Times a calendar change the way the user waits for it: from their last answer (Save, Delete, the drop) to
// Google's confirmation reaching the window, then to the calendar redrawn with it. Sent to the diagnostics
// log (`log_calendar_write`), beside the backend's own line, which splits the write into Google's time and
// Pheeme's.
import { type CalendarWriteShown, type EditScope, logCalendarWrite } from "../lib/tauri";

export interface WriteTimer {
  /** Google confirmed the change; the redraw starts now. */
  wrote(): void;
  /** The calendar shows it (or the write failed). Reports once. */
  done(outcome: CalendarWriteShown["outcome"]): void;
}

export function timeWrite(
  op: CalendarWriteShown["op"],
  scope: EditScope | null = null,
  now: () => number = () => performance.now(),
  report: (r: CalendarWriteShown) => unknown = logCalendarWrite,
): WriteTimer {
  const started = now();
  let wroteAt: number | null = null;
  let reported = false;
  return {
    wrote() {
      wroteAt ??= now();
    },
    done(outcome) {
      if (reported) return;
      reported = true;
      const end = now();
      const shown = outcome === "shown" && wroteAt !== null;
      const ms = (n: number) => Math.round(n);
      // The log is a side channel: a failure to write it must not touch the change.
      void Promise.resolve()
        .then(() =>
          report({
            op,
            scope,
            outcome,
            writeMs: ms((wroteAt ?? end) - started),
            redrawMs: shown ? ms(end - wroteAt!) : null,
            totalMs: ms(end - started),
          }),
        )
        .catch(() => {});
    },
  };
}
