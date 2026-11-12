/** Calendar for browser preview: two accounts' calendars and a busy week around today (`src-tauri/src/calendar/` in the app). */

import { emit } from "@tauri-apps/api/event";
import {
  CALENDAR_EVENTS,
  type CalendarAccess,
  type CalendarAccount,
  type CalendarEvent,
  type CalendarInfo,
  type Attendee,
  type EventDetail,
  type EventEdit,
  type EventRef,
  type EventTime,
  type Invite,
  type MeetingLink,
} from "../lib/tauri";

type Args = Record<string, unknown> | undefined;

// Video calls the fixtures join (as `calendar/meeting.rs` would find them).
const MEET: MeetingLink = { url: "https://meet.google.com/abc-defg-hij", provider: "Google Meet" };
const ZOOM: MeetingLink = { url: "https://acme.zoom.us/j/81234567890?pwd=demo", provider: "Zoom" };
const TEAMS: MeetingLink = {
  url: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_demo%40thread.v2/0",
  provider: "Microsoft Teams",
};

const pad = (n: number) => String(n).padStart(2, "0");
const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function calendar(id: string, summary: string, color: string, primary = false): CalendarInfo {
  return {
    id,
    summary,
    backgroundColor: color,
    foregroundColor: "#000000",
    accessRole: id.includes("holiday") ? "reader" : "owner",
    primary,
    hidden: false,
  };
}

/**
 * `access`: the second account's calendar access (`?calendar=missing_scope`, `api_disabled`,
 * `unknown` or `error`; `on` by default). `now` anchors the fixture week.
 */
export function createCalendarHandlers(
  accounts: { id: string; email: string }[],
  access: string | null,
  now = Date.now(),
) {
  const statuses = new Map<string, CalendarAccess["status"]>(
    accounts.map((a, i) => [a.id, (i === 1 && access ? access : "on") as CalendarAccess["status"]]),
  );
  const [first, second] = accounts;
  const calendars = new Map<string, CalendarInfo[]>();
  if (first)
    calendars.set(first.id, [
      calendar(first.email, first.email, "#9fe1e7", true),
      calendar("team", "Team", "#f691b2"),
      calendar("en.usa#holiday@group.v.calendar.google.com", "Holidays", "#16a765"),
    ]);
  if (second) calendars.set(second.id, [calendar(second.email, second.email, "#fbe983", true)]);

  // Monday of the week containing `now`, local midnight.
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const at = (dayOffset: number, hour: number, minute = 0) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + dayOffset);
    d.setHours(hour, minute, 0, 0);
    return d.getTime();
  };
  const dateAt = (dayOffset: number) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + dayOffset);
    return isoDate(d);
  };

  const base = (
    account: { id: string; email: string },
    calendarId: string,
    id: string,
    summary: string,
  ): CalendarEvent => ({
    accountId: account.id,
    calendarId,
    id,
    masterId: null,
    summary,
    start: { ms: null, date: null, timeZone: null },
    end: { ms: null, date: null, timeZone: null },
    allDay: false,
    status: "confirmed",
    selfResponse: null,
    location: null,
    hasConference: false,
    meeting: null,
    colorId: null,
    transparency: null,
    recurring: false,
    canEdit: false,
  });
  const timed = (
    account: { id: string; email: string },
    calendarId: string,
    id: string,
    summary: string,
    start: number,
    end: number,
    extra: Partial<CalendarEvent> = {},
  ): CalendarEvent => ({
    ...base(account, calendarId, id, summary),
    start: { ms: start, date: null, timeZone: "America/New_York" },
    end: { ms: end, date: null, timeZone: "America/New_York" },
    ...extra,
  });
  const allDay = (
    account: { id: string; email: string },
    calendarId: string,
    id: string,
    summary: string,
    fromDay: number,
    days: number,
  ): CalendarEvent => ({
    ...base(account, calendarId, id, summary),
    start: { ms: null, date: dateAt(fromDay), timeZone: null },
    end: { ms: null, date: dateAt(fromDay + days), timeZone: null },
    allDay: true,
    transparency: "transparent",
  });

  const events: CalendarEvent[] = [];
  if (first) {
    const primary = first.email;
    // A weekly Monday standup; this week's was moved to Tuesday.
    for (let week = -8; week <= 8; week++) {
      const start = at(week * 7, 9);
      const date = dateAt(week * 7).replace(/-/g, "");
      const occurrence = {
        masterId: "standup",
        recurring: true,
        hasConference: true,
        meeting: MEET,
        selfResponse: "accepted",
      };
      if (week === 0)
        events.push(
          timed(first, primary, `standup_${date}`, "Standup (moved)", at(1, 10), at(1, 10, 15), {
            ...occurrence,
          }),
        );
      else
        events.push(
          timed(
            first,
            primary,
            `standup_${date}`,
            "Standup",
            start,
            start + 15 * 60_000,
            occurrence,
          ),
        );
    }
    events.push(
      timed(first, primary, "lunch", "Lunch with Dana", at(3, 12), at(3, 13), {
        location: "Tartine",
      }),
      timed(first, primary, "vendor", "Vendor demo", at(1, 16), at(1, 17), {
        selfResponse: "declined",
        location: ZOOM.url,
        meeting: ZOOM,
      }),
      timed(first, "team", "planning", "Team planning", at(2, 11), at(2, 12), {
        meeting: TEAMS,
      }),
      allDay(first, "en.usa#holiday@group.v.calendar.google.com", "holiday", "Veterans Day", 3, 1),
    );
  }
  if (second) {
    const primary = second.email;
    events.push(
      timed(second, primary, "design-review", "Design review", at(3, 14), at(3, 15), {
        selfResponse: "needsAction",
        hasConference: true,
        meeting: MEET,
        location: "Google Meet",
      }),
      timed(second, primary, "one-on-one", "1:1 Alex", at(3, 14, 30), at(3, 15, 30), {
        selfResponse: "accepted",
      }),
      allDay(second, primary, "summit", "Design Summit", 2, 3),
    );
  }

  // Who organizes each fixture event, when it isn't the account itself.
  const organizers = new Map<string, string>([["design-review", "morgan@example.org"]]);
  const descriptions = new Map<string, string>([
    ["planning", "Agenda: Q1 goals, hiring, the offsite."],
  ]);
  /** What the editor sets beyond the listed fields, by event id. */
  type Extra = Pick<
    EventDetail,
    | "reminders"
    | "visibility"
    | "recurrence"
    | "guestsCanModify"
    | "guestsCanInviteOthers"
    | "guestsCanSeeOtherGuests"
  > & { guests: Attendee[] };
  const extras = new Map<string, Extra>();
  const guest = (email: string, name: string | null, response: string): Attendee => ({
    email,
    name,
    response,
    optional: false,
    organizer: false,
    isSelf: false,
    resource: false,
    comment: null,
  });
  const extraOf = (e: CalendarEvent): Extra => {
    let x = extras.get(e.id);
    if (!x) {
      x = {
        reminders: { useDefault: true, overrides: [] },
        visibility: null,
        recurrence: e.recurring ? ["RRULE:FREQ=WEEKLY;BYDAY=MO"] : [],
        guestsCanModify: false,
        guestsCanInviteOthers: true,
        guestsCanSeeOtherGuests: true,
        guests:
          e.id === "planning"
            ? [
                guest("dana@example.com", "Dana Whitaker", "accepted"),
                guest("sam@example.com", null, "needsAction"),
              ]
            : e.id === "design-review"
              ? [
                  { ...guest("morgan@example.org", "Morgan Lee", "accepted"), organizer: true },
                  guest("sam@example.com", "Sam Ortiz", "tentative"),
                  guest("priya@example.org", "Priya Raman", "needsAction"),
                ]
              : [],
      };
      extras.set(e.id, x);
    }
    return x;
  };
  const find = (args: Args) =>
    events.find(
      (e) =>
        e.accountId === String(args?.accountId) &&
        e.calendarId === String(args?.calendarId) &&
        e.id === String(args?.eventId),
    );
  const missing = () => ({ code: "not_found", message: "That event isn't available any more." });
  const readOnly = () => ({
    code: "read_only",
    message: "Only the organizer can change this event.",
  });
  const changed = (accountId: string) =>
    void emit(CALENDAR_EVENTS.updated, { accountId }).catch(() => {});
  const timeOf = (t: EventEdit["start"], fallback: EventTime): EventTime =>
    t
      ? { ms: t.ms ?? null, date: t.date ?? null, timeZone: t.timeZone ?? fallback.timeZone }
      : fallback;
  /** Applies an edit's fields to an event. */
  const apply = (e: CalendarEvent, edit: EventEdit) => {
    if (edit.summary != null) e.summary = edit.summary || null;
    if (edit.location != null) e.location = edit.location || null;
    if (edit.description != null) descriptions.set(e.id, edit.description);
    if (edit.colorId != null) e.colorId = edit.colorId || null;
    if (edit.transparency != null) e.transparency = edit.transparency;
    if (edit.conference != null) {
      e.hasConference = edit.conference;
      if (edit.conference) e.meeting = MEET;
      else if (e.meeting === MEET) e.meeting = null;
    }
    if (edit.recurrence != null) e.recurring = edit.recurrence.length > 0;
    if (edit.start) e.start = timeOf(edit.start, e.start);
    if (edit.end) e.end = timeOf(edit.end, e.end);
    if (edit.start || edit.end) e.allDay = e.start.date !== null;
    const x = extraOf(e);
    if (edit.reminders)
      x.reminders = {
        useDefault: edit.reminders.useDefault,
        overrides: edit.reminders.overrides ?? [],
      };
    if (edit.visibility != null) x.visibility = edit.visibility;
    if (edit.recurrence != null) x.recurrence = edit.recurrence;
    if (edit.guestsCanModify != null) x.guestsCanModify = edit.guestsCanModify;
    if (edit.guestsCanInviteOthers != null) x.guestsCanInviteOthers = edit.guestsCanInviteOthers;
    if (edit.guestsCanSeeOtherGuests != null)
      x.guestsCanSeeOtherGuests = edit.guestsCanSeeOtherGuests;
    if (edit.attendees != null)
      x.guests = edit.attendees.map(
        (a) =>
          x.guests.find((g) => g.email?.toLowerCase() === a.email.toLowerCase()) ??
          guest(a.email, null, "needsAction"),
      );
  };
  const isOrganizer = (e: CalendarEvent) => !organizers.has(e.id);
  const writable = (e: CalendarEvent) =>
    ["owner", "writer"].includes(
      calendars.get(e.accountId)?.find((c) => c.id === e.calendarId)?.accessRole ?? "",
    );
  /** As the app lists it: with whether this account may change it. */
  const listed = (e: CalendarEvent): CalendarEvent => ({
    ...e,
    canEdit: isOrganizer(e) && writable(e),
  });
  const ref = (e: CalendarEvent): EventRef => ({
    accountId: e.accountId,
    calendarId: e.calendarId,
    id: e.id,
  });
  let nextId = 1;
  const placeholder = (accountId: string, calendarId: string): CalendarEvent => ({
    ...base({ id: accountId, email: "" }, calendarId, `new-${nextId++}`, ""),
    summary: null,
  });
  /** The event and, for "this", only it; otherwise every occurrence of its series. */
  const inScope = (e: CalendarEvent, scope: unknown) =>
    scope === "this" || !e.masterId
      ? [e]
      : events.filter((o) => o.accountId === e.accountId && o.masterId === e.masterId);

  const shown = (e: CalendarEvent) =>
    statuses.get(e.accountId) === "on" &&
    !calendars.get(e.accountId)?.find((c) => c.id === e.calendarId)?.hidden;
  const startKey = (e: CalendarEvent) => e.start.ms ?? Date.parse(`${e.start.date}T00:00:00`);
  const endKey = (e: CalendarEvent) => e.end.ms ?? Date.parse(`${e.end.date}T00:00:00`);
  const accessOf = (accountId: string): CalendarAccess => {
    const status = statuses.get(accountId) ?? "unknown";
    return {
      status,
      message: status === "error" ? "Calendar API error 500: Backend Error" : null,
      enableUrl:
        status === "api_disabled"
          ? "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com"
          : null,
      syncedAt: status === "on" ? now - 60_000 : null,
    };
  };

  /** The invitations the fixture mail carries (`fixtures.ts`), by message id. */
  const invitations = new Map<string, { eventId: string | null; cancelled: boolean }>([
    ["w-13-m1", { eventId: "design-review", cancelled: false }],
    ["p-20-m1", { eventId: null, cancelled: true }],
  ]);
  const morgan = { email: "morgan@example.org", name: "Morgan Lee", isSelf: false };

  const handlers = {
    calendar_accounts: (): CalendarAccount[] =>
      accounts.map((a) => {
        const on = statuses.get(a.id) === "on";
        return {
          accountId: a.id,
          email: a.email,
          access: accessOf(a.id),
          timeZone: on ? Intl.DateTimeFormat().resolvedOptions().timeZone : null,
          weekStart: on ? 0 : null,
          calendars: on ? (calendars.get(a.id) ?? []) : [],
        };
      }),
    calendar_events: (args: Args): CalendarEvent[] => {
      const from = Number(args?.fromMs);
      const to = Number(args?.toMs);
      return events
        .filter((e) => shown(e) && startKey(e) < to && endKey(e) > from)
        .sort(
          (a, b) =>
            startKey(a) - startKey(b) ||
            Number(b.allDay) - Number(a.allDay) ||
            a.id.localeCompare(b.id),
        )
        .map(listed);
    },
    search_calendar_events: (args: Args): CalendarEvent[] => {
      const words = String(args?.query ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      if (!words.length) return [];
      const from = Number(args?.fromMs);
      const to = Number(args?.toMs);
      const text = (e: CalendarEvent) =>
        [
          e.summary,
          e.location,
          descriptions.get(e.id),
          ...extraOf(e).guests.flatMap((g) => [g.email, g.name]),
        ]
          .filter(Boolean)
          .join("\n")
          .toLowerCase();
      return events
        .filter((e) => shown(e) && startKey(e) < to && endKey(e) > from)
        .filter((e) => words.every((w) => text(e).includes(w)))
        .sort((a, b) => startKey(a) - startKey(b))
        .map(listed);
    },
    set_calendar_hidden: (args: Args) => {
      const accountId = String(args?.accountId);
      const cal = calendars.get(accountId)?.find((c) => c.id === String(args?.calendarId));
      if (cal) cal.hidden = Boolean(args?.hidden);
      void emit(CALENDAR_EVENTS.updated, { accountId }).catch(() => {});
    },
    calendar_sync_now: (args: Args): CalendarAccess => {
      const accountId = String(args?.accountId);
      // After turning the API on (or allowing access), checking again works.
      statuses.set(accountId, "on");
      void emit(CALENDAR_EVENTS.access, { accountId, status: "on" }).catch(() => {});
      return accessOf(accountId);
    },
    set_calendar_foreground: () => undefined,
    calendar_event_detail: (args: Args): EventDetail => {
      const e = find(args);
      if (!e) throw missing();
      const account = accounts.find((a) => a.id === e.accountId);
      const organizer = organizers.get(e.id) ?? account?.email ?? null;
      const mine = isOrganizer(e);
      const { guests, ...x } = extraOf(e);
      const self: Attendee[] = e.selfResponse
        ? [
            {
              email: account?.email ?? null,
              name: null,
              response: e.selfResponse,
              optional: false,
              organizer: false,
              isSelf: true,
              resource: false,
              comment: null,
            },
          ]
        : [];
      return {
        ...listed(e),
        ...x,
        description: descriptions.get(e.id) ?? null,
        organizer: { email: organizer, name: null, isSelf: mine },
        attendees: [...self, ...guests],
        meetUrl: e.hasConference ? MEET.url : null,
        conferencePending: false,
        originalStart: null,
        htmlLink: null,
        canEdit: listed(e).canEdit,
        canRsvp: e.selfResponse !== null,
        canDelete: writable(e),
      };
    },
    create_calendar_event: (args: Args): EventRef => {
      const e = placeholder(String(args?.accountId), String(args?.calendarId));
      apply(e, (args?.edit ?? {}) as EventEdit);
      events.push(e);
      changed(e.accountId);
      return ref(e);
    },
    update_calendar_event: (args: Args): EventRef => {
      const e = find(args);
      if (!e) throw missing();
      if (!isOrganizer(e)) throw readOnly();
      // "following" behaves like "all" here. Other occurrences move by as much as this one did.
      const edit = (args?.edit ?? {}) as EventEdit;
      const shift = (t: EventEdit["start"], from: EventTime) =>
        t?.ms != null && from.ms != null ? t.ms - from.ms : 0;
      const startBy = shift(edit.start, e.start);
      const endBy = shift(edit.end, e.end);
      for (const o of inScope(e, args?.scope)) {
        if (o === e || (!startBy && !endBy)) apply(o, edit);
        else
          apply(o, {
            ...edit,
            start: o.start.ms != null ? { ...edit.start, ms: o.start.ms + startBy } : edit.start,
            end: o.end.ms != null ? { ...edit.end, ms: o.end.ms + endBy } : edit.end,
          });
      }
      changed(e.accountId);
      return ref(e);
    },
    delete_calendar_event: (args: Args) => {
      const e = find(args);
      if (!e) throw missing();
      // A guest can take an invite off their own calendar.
      if (!writable(e)) throw readOnly();
      for (const o of inScope(e, args?.scope)) events.splice(events.indexOf(o), 1);
      changed(e.accountId);
    },
    move_calendar_event: (args: Args): EventRef => {
      const e = find(args);
      if (!e) throw missing();
      if (!isOrganizer(e)) throw readOnly();
      e.calendarId = String(args?.destinationCalendarId);
      changed(e.accountId);
      return ref(e);
    },
    copy_calendar_event: (args: Args): EventRef => {
      const e = find(args);
      if (!e) throw missing();
      const copy: CalendarEvent = {
        ...e,
        accountId: String(args?.toAccountId),
        calendarId: String(args?.toCalendarId),
        id: `copy-${nextId++}`,
        masterId: null,
        recurring: false,
        selfResponse: null,
      };
      events.push(copy);
      changed(copy.accountId);
      return ref(copy);
    },
    respond_to_calendar_event: (args: Args): EventRef => {
      const e = find(args);
      if (!e) throw missing();
      for (const o of inScope(e, args?.scope)) o.selfResponse = String(args?.response);
      changed(e.accountId);
      return ref(e);
    },
    message_invite: (args: Args): Invite | null => {
      const accountId = String(args?.accountId);
      const spec = invitations.get(String(args?.messageId));
      if (!spec) return null;
      const account = accounts.find((a) => a.id === accountId);
      const self = (response: string): Attendee => ({
        ...guest(account?.email ?? "", null, response),
        isSelf: true,
      });
      if (spec.cancelled) {
        const start = at(4, 18, 30);
        return {
          method: "CANCEL",
          uid: "book-club@google.com",
          sequence: 2,
          cancelled: true,
          summary: "Book club",
          description: null,
          location: "Mira's place",
          meeting: null,
          start: { ms: start, date: null, timeZone: "America/New_York" },
          end: { ms: start + 90 * 60_000, date: null, timeZone: "America/New_York" },
          allDay: false,
          recurrence: [],
          recurrenceId: null,
          organizer: { email: "mira@example.net", name: "Mira Okafor", isSelf: false },
          attendees: [self("needsAction")],
          live: null,
          liveSequence: null,
          import: null,
        };
      }
      const e = events.find((o) => o.accountId === accountId && o.id === spec.eventId);
      if (!e) return null;
      const live = shown(e)
        ? handlers.calendar_event_detail({
            accountId,
            calendarId: e.calendarId,
            eventId: e.id,
          })
        : null;
      return {
        method: "REQUEST",
        uid: e.id,
        sequence: 0,
        cancelled: false,
        summary: e.summary,
        description: "Walk through the new onboarding flow, then decide on the copy.",
        location: "Room 4, Studio",
        meeting: MEET,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
        recurrence: [],
        recurrenceId: null,
        organizer: morgan,
        attendees: [
          { ...guest(morgan.email, morgan.name, "accepted"), organizer: true },
          self("needsAction"),
          guest("sam@example.com", "Sam Ortiz", "tentative"),
          guest("priya@example.org", "Priya Raman", "needsAction"),
        ],
        live,
        liveSequence: live ? 0 : null,
        import: { summary: e.summary },
      };
    },
    respond_to_calendar_invite: (args: Args): EventRef => {
      // The preview's invites carry their event id as iCalendar UID.
      const uid = String(args?.icalUid);
      const e = events.find((o) => o.accountId === String(args?.accountId) && o.id === uid);
      if (!e) throw missing();
      e.selfResponse = String(args?.response);
      changed(e.accountId);
      return ref(e);
    },
  };
  return handlers;
}
