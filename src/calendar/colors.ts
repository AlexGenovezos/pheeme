// Event colours: the calendar's colour from Google, or the event's own `colorId`, with text that
// reads on it (4.5:1) in every theme, as label chips do.
import type { CalendarEvent, CalendarInfo } from "../lib/tauri";
import { contrastRatio } from "../styles/themes/color";

/** Google Calendar's event colours (`colors.get` → `event`), `colorId` "1" to "11". */
export const EVENT_COLORS: Record<string, string> = {
  "1": "#a4bdfc",
  "2": "#7ae7bf",
  "3": "#dbadff",
  "4": "#ff887c",
  "5": "#fbd75b",
  "6": "#ffb878",
  "7": "#46d6db",
  "8": "#e1e1e1",
  "9": "#5484ed",
  "10": "#51b749",
  "11": "#dc2127",
};

/** A calendar with no colour from Google. */
const FALLBACK = "#9fc6e7";

export interface EventColors {
  background: string;
  text: string;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Black or white, whichever reads better on `background`. */
export function textOn(background: string): string {
  return contrastRatio("#ffffff", background) > contrastRatio("#000000", background)
    ? "#ffffff"
    : "#000000";
}

/** The calendar's own colour (its sidebar tick box). */
export function calendarColor(calendar: CalendarInfo | undefined): string {
  const bg = calendar?.backgroundColor?.toLowerCase();
  return bg && HEX.test(bg) ? bg : FALLBACK;
}

/** How an event draws: its colour if it has one, else its calendar's. */
export function eventColors(event: CalendarEvent, calendar: CalendarInfo | undefined): EventColors {
  const own = event.colorId ? EVENT_COLORS[event.colorId] : undefined;
  const background = own ?? calendarColor(calendar);
  const given = !own ? calendar?.foregroundColor?.toLowerCase() : undefined;
  const text =
    given && HEX.test(given) && contrastRatio(given, background) >= 4.5
      ? given
      : textOn(background);
  return { background, text };
}
