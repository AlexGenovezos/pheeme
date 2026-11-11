// Mail's invite card, the parts with no React in them: which message carries an invitation, the
// event the card shows (the calendar's live copy over the email's), what changed since the email,
// and which of the user's events clash with it.
import type { CalendarEvent, EventTime, Invite } from "../lib/tauri";
import { dateOf, formatTime } from "./dates";
import { describeWhen } from "./EventPopover";
import { eventTitle } from "./EventBlock";

/** The account's own answer: on the live event, else in the email. */
export function selfAnswer(invite: Invite): string | null {
  if (invite.live) return invite.live.selfResponse;
  return invite.attendees.find((a) => a.isSelf)?.response ?? null;
}

/** The event the card shows: the calendar's copy when cached, else the email's, as the grid draws events. */
export function shownEvent(invite: Invite, accountId: string): CalendarEvent {
  if (invite.live) return invite.live;
  return {
    accountId,
    calendarId: "",
    id: `invite:${invite.uid}`,
    masterId: null,
    summary: invite.summary,
    start: invite.start,
    end: invite.end,
    allDay: invite.allDay,
    status: invite.cancelled ? "cancelled" : "confirmed",
    selfResponse: selfAnswer(invite) ?? "needsAction",
    location: invite.location,
    hasConference: invite.meetingUrl !== null,
    colorId: null,
    transparency: null,
    recurring: invite.recurrence.length > 0,
    canEdit: false,
  };
}

const sameTime = (a: EventTime, b: EventTime) => a.ms === b.ms && a.date === b.date;

export interface Notice {
  tone: "danger" | "info";
  text: string;
}

const REPLY_WORDS: Record<string, string> = {
  accepted: "accepted",
  declined: "declined",
  tentative: "might attend",
};

/** What the card says about the email beside the event: cancelled, answered, moved or updated. */
export function inviteNotice(invite: Invite, tz: string): Notice | null {
  if (invite.cancelled || invite.live?.status === "cancelled")
    return { tone: "danger", text: "This event was cancelled." };
  if (invite.method === "REPLY") {
    const guest = invite.attendees[0];
    if (!guest) return null;
    const who = guest.name || guest.email || "A guest";
    const verb = REPLY_WORDS[guest.response ?? ""] ?? "replied to";
    return { tone: "info", text: `${who} ${verb} this invitation.` };
  }
  const live = invite.live;
  if (live && (!sameTime(live.start, invite.start) || !sameTime(live.end, invite.end)))
    return { tone: "info", text: `Time changed to ${describeWhen(live, tz)}.` };
  if (live && invite.liveSequence != null && invite.liveSequence > invite.sequence)
    return {
      tone: "info",
      text: "This event has changed since this email. It shows as it is now.",
    };
  if (invite.sequence > 0 && invite.method === "REQUEST")
    return { tone: "info", text: "This is an updated invitation." };
  return null;
}

/** Whether the card can answer: a request or published event that isn't cancelled, that you're invited to (not your own). */
export function canAnswer(invite: Invite): boolean {
  if (invite.cancelled || invite.live?.status === "cancelled") return false;
  if (invite.method !== "REQUEST" && invite.method !== "PUBLISH") return false;
  if (invite.live) return invite.live.canRsvp;
  if (invite.organizer?.isSelf) return false;
  // One changed occurrence answers on the calendar's copy, which isn't cached yet.
  return invite.recurrenceId === null && invite.import !== null;
}

/**
 * Whether a calendar event is the invitation itself: the same event, an occurrence of its series at the
 * same time, or the same invitation on another of the user's calendars (same title and times).
 */
export function isSameEvent(e: CalendarEvent, invite: CalendarEvent): boolean {
  const sameTimes =
    e.start.ms === invite.start.ms &&
    e.end.ms === invite.end.ms &&
    e.start.date === invite.start.date;
  if (e.accountId === invite.accountId && e.calendarId === invite.calendarId) {
    if (e.id === invite.id) return true;
    if (e.masterId === invite.id && sameTimes) return true;
  }
  return e.summary === invite.summary && sameTimes;
}

/**
 * The user's events that overlap the invitation: timed, busy, not declined, and not the invitation itself
 * (on this calendar, or the same event on another account's).
 */
export function clashes(events: CalendarEvent[], invite: CalendarEvent): CalendarEvent[] {
  if (invite.allDay || invite.start.ms == null) return [];
  const start = invite.start.ms;
  const end = Math.max(invite.end.ms ?? start, start + 1);
  return events.filter(
    (e) =>
      !e.allDay &&
      e.start.ms != null &&
      e.end.ms != null &&
      e.start.ms < end &&
      e.end.ms > start &&
      e.status !== "cancelled" &&
      e.selfResponse !== "declined" &&
      e.transparency !== "transparent" &&
      !isSameEvent(e, invite),
  );
}

/** "Overlaps 1:1 Alex (2:30 PM)", "… and Lunch (12:00 PM)", "… and 2 more". */
export function clashText(list: CalendarEvent[], tz: string): string | null {
  if (list.length === 0) return null;
  const name = (e: CalendarEvent) => `${eventTitle(e)} (${formatTime(e.start.ms!, tz)})`;
  if (list.length === 1) return `Overlaps ${name(list[0])}`;
  if (list.length === 2) return `Overlaps ${name(list[0])} and ${name(list[1])}`;
  return `Overlaps ${name(list[0])} and ${list.length - 1} more`;
}

/** The hours (minutes past midnight) the mini day view shows: an hour either side, at least four hours, within the day. */
export function miniWindow(start: number, end: number): { from: number; to: number } {
  const DAY = 24 * 60;
  let from = Math.max(0, Math.floor(start / 60) * 60 - 60);
  let to = Math.min(DAY, Math.ceil(Math.max(end, start + 30) / 60) * 60 + 60);
  if (to - from < 4 * 60) {
    const grow = 4 * 60 - (to - from);
    from = Math.max(0, from - Math.floor(grow / 120) * 60);
    to = Math.min(DAY, from + 4 * 60);
    from = Math.max(0, to - 4 * 60);
  }
  return { from, to };
}

/** The day the event starts on (`YYYY-MM-DD`) in `tz`. */
export const startDay = (e: CalendarEvent, tz: string): string =>
  e.start.date ?? dateOf(e.start.ms ?? Date.now(), tz);
