// Event templates, the parts with no React or IPC in them: what an event's form saves as a
// template, a template's details laid over a new event's form, the times a new event from one
// gets, and the one-line summary Settings and the save dialog show. Stored by Rust
// (`calendar/templates.rs`); `templatesStore.ts` holds the list.
import type { EventTemplate, TemplateFields } from "../lib/tauri";
import { addDays, daysBetween, wallClock, zonedMs } from "./dates";
import { type EventForm, type Guest, reminderFrom, reminderMinutes } from "./eventForm";
import type { FoundTime } from "./fromEmail";

const MINUTE = 60_000;
/** A timed template made from a form whose end isn't after its start: an hour, as new events get. */
const DEFAULT_MINUTES = 60;

/** The length of a form's event: minutes when timed, days when all-day. */
function formLength(f: EventForm): number {
  if (f.allDay) return Math.max(1, daysBetween(f.startDate, f.endDate) + 1);
  const minutes = Math.round(
    (zonedMs(f.endDate, f.endMinutes, f.endZone) -
      zonedMs(f.startDate, f.startMinutes, f.startZone)) /
      MINUTE,
  );
  return minutes > 0 ? minutes : DEFAULT_MINUTES;
}

/** What saving this form as a template keeps: everything but when it is and whether it repeats. */
export function templateFields(f: EventForm): TemplateFields {
  return {
    summary: f.summary.trim(),
    allDay: f.allDay,
    length: formLength(f),
    accountId: f.accountId || null,
    calendarId: f.calendarId || null,
    guests: f.guests.map((g) => ({ name: g.name, address: g.address, optional: g.optional })),
    guestsCanModify: f.guestsCanModify,
    guestsCanInviteOthers: f.guestsCanInviteOthers,
    guestsCanSeeOtherGuests: f.guestsCanSeeOtherGuests,
    meet: f.meet,
    location: f.location,
    description: f.description,
    colorId: f.colorId,
    remindersDefault: f.remindersDefault,
    reminders: f.reminders.map((r) => ({ method: r.method, minutes: reminderMinutes(r) })),
    transparency: f.transparency,
    visibility: f.visibility,
  };
}

/**
 * When a new event from template `t` is. `when` is what the sentence said (null: nothing),
 * `lengthSaid` whether it gave a length or an end of its own, and `fallbackStart` the time a new
 * event gets when nothing says (`defaultTimes`). A timed template given only a day starts at
 * 9 AM that day; an all-day template given a time becomes a timed event at it.
 */
export function templateTimes(
  t: TemplateFields,
  when: FoundTime | null,
  lengthSaid: boolean,
  fallbackStart: number,
  tz: string,
): FoundTime {
  if (t.allDay) {
    if (when?.allDay)
      return when.lastDate !== when.date || t.length === 1
        ? when
        : { ...when, lastDate: addDays(when.date, t.length - 1) };
    if (when) return when;
    const date = wallClock(fallbackStart, tz).date;
    return { allDay: true, date, lastDate: addDays(date, t.length - 1) };
  }
  const start = !when ? fallbackStart : when.allDay ? zonedMs(when.date, 9 * 60, tz) : when.start;
  if (when && !when.allDay && lengthSaid) return when;
  return { allDay: false, start, end: start + t.length * MINUTE };
}

/**
 * `form` with template `t`'s details. The form keeps its times. The template's calendar is used
 * when `writable` says it can take new events, else the form's stays (the default calendar).
 */
export function withTemplate(
  form: EventForm,
  t: TemplateFields,
  writable: (accountId: string, calendarId: string) => boolean,
): EventForm {
  const own = t.accountId && t.calendarId && writable(t.accountId, t.calendarId);
  return {
    ...form,
    accountId: own ? t.accountId! : form.accountId,
    calendarId: own ? t.calendarId! : form.calendarId,
    summary: t.summary,
    guests: t.guests.map((g): Guest => ({ ...g })),
    guestsCanModify: t.guestsCanModify,
    guestsCanInviteOthers: t.guestsCanInviteOthers,
    guestsCanSeeOtherGuests: t.guestsCanSeeOtherGuests,
    meet: t.meet,
    location: t.location,
    description: t.description,
    colorId: t.colorId,
    remindersDefault: t.remindersDefault,
    reminders: t.reminders.map((r) => reminderFrom(r.method, r.minutes)),
    transparency: t.transparency,
    visibility: t.visibility,
  };
}

/** "45 min", "1 hr", "1 hr 30 min", "All day", "3 days". */
export function describeLength(t: Pick<TemplateFields, "allDay" | "length">): string {
  if (t.allDay) return t.length === 1 ? "All day" : `${t.length} days`;
  const hours = Math.floor(t.length / 60);
  const minutes = t.length % 60;
  if (!hours) return `${minutes} min`;
  return minutes ? `${hours} hr ${minutes} min` : `${hours} hr`;
}

/**
 * One line about what a template fills in: "45 min · Work · 2 guests · Google Meet · Mission
 * Cliffs". `calendarName` is its calendar's name, null when that calendar can't take events, and
 * undefined when the calendars aren't known yet (left out).
 */
export function describeTemplate(
  t: TemplateFields,
  calendarName: string | null | undefined,
): string {
  const parts = [describeLength(t)];
  if (calendarName !== undefined) parts.push(calendarName ?? "Default calendar");
  if (t.guests.length) parts.push(t.guests.length === 1 ? "1 guest" : `${t.guests.length} guests`);
  if (t.meet) parts.push("Google Meet");
  if (t.location.trim()) parts.push(t.location.trim());
  return parts.join(" · ");
}

/** Templates by name, ignoring capitals. */
export const byName = (templates: EventTemplate[]): EventTemplate[] =>
  [...templates].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
