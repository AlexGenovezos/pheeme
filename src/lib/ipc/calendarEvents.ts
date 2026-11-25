import { call } from "./call";
import type { CalendarEvent, EventTime, MeetingLink } from "./calendar";

/** One end of an event in an edit: `ms` (UTC) for timed events, `date` for all-day ones. */
export interface TimeInput {
  ms?: number | null;
  date?: string | null;
  timeZone?: string | null;
}
export interface AttendeeInput {
  email: string;
  optional?: boolean;
}
export interface RemindersInput {
  useDefault: boolean;
  overrides?: { method: "popup" | "email"; minutes: number }[];
}
/** Changes to an event: an omitted (or null) field stays as it is; `""` clears a text field. */
export interface EventEdit {
  summary?: string | null;
  description?: string | null;
  location?: string | null;
  /** `"1"` to `"11"`. */
  colorId?: string | null;
  start?: TimeInput | null;
  end?: TimeInput | null;
  /** RRULE lines; `[]` stops the event repeating. */
  recurrence?: string[] | null;
  attendees?: AttendeeInput[] | null;
  guestsCanModify?: boolean | null;
  guestsCanInviteOthers?: boolean | null;
  guestsCanSeeOtherGuests?: boolean | null;
  /** `true` adds a Google Meet link, `false` removes it. */
  conference?: boolean | null;
  reminders?: RemindersInput | null;
  transparency?: "opaque" | "transparent" | null;
  visibility?: "default" | "public" | "private" | "confidential" | null;
}
/** Which events of a series a change applies to (a single event ignores it). */
export type EditScope = "this" | "following" | "all";
/** Whether Google emails the guests about a change. */
export type SendUpdates = "all" | "none";
/** Where a written event lives. */
export interface EventRef {
  accountId: string;
  calendarId: string;
  id: string;
}
export interface Attendee {
  email: string | null;
  name: string | null;
  response: string | null;
  optional: boolean;
  organizer: boolean;
  isSelf: boolean;
  resource: boolean;
  comment: string | null;
}
/** Everything the event panel shows and edits about one event or occurrence. */
export interface EventDetail extends CalendarEvent {
  description: string | null;
  organizer: { email: string | null; name: string | null; isSelf: boolean } | null;
  attendees: Attendee[];
  meetUrl: string | null;
  /** A Meet link was asked for and Google hasn't made it yet. */
  conferencePending: boolean;
  recurrence: string[];
  /** For an occurrence: when it was originally scheduled. */
  originalStart: EventTime | null;
  reminders: { useDefault: boolean; overrides: { method: string; minutes: number }[] };
  visibility: string | null;
  htmlLink: string | null;
  guestsCanModify: boolean;
  guestsCanInviteOthers: boolean;
  guestsCanSeeOtherGuests: boolean;
  canEdit: boolean;
  canRsvp: boolean;
  canDelete: boolean;
}

/** The full detail of one event or occurrence (local). */
export const getCalendarEventDetail = (accountId: string, calendarId: string, eventId: string) =>
  call("calendar_event_detail", { accountId, calendarId, eventId });
export const createCalendarEvent = (
  accountId: string,
  calendarId: string,
  edit: EventEdit,
  sendUpdates: SendUpdates = "none",
) => call("create_calendar_event", { accountId, calendarId, edit, sendUpdates });
export const updateCalendarEvent = (
  accountId: string,
  calendarId: string,
  eventId: string,
  scope: EditScope,
  edit: EventEdit,
  sendUpdates: SendUpdates = "none",
) =>
  call("update_calendar_event", {
    accountId,
    calendarId,
    eventId,
    scope,
    edit,
    sendUpdates,
  });
export const deleteCalendarEvent = (
  accountId: string,
  calendarId: string,
  eventId: string,
  scope: EditScope,
  sendUpdates: SendUpdates = "none",
) => call("delete_calendar_event", { accountId, calendarId, eventId, scope, sendUpdates });
/** Move an event (or whole series) to another calendar of the same account. */
export const moveCalendarEvent = (
  accountId: string,
  calendarId: string,
  eventId: string,
  destinationCalendarId: string,
  sendUpdates: SendUpdates = "none",
) =>
  call("move_calendar_event", {
    accountId,
    calendarId,
    eventId,
    destinationCalendarId,
    sendUpdates,
  });
/** Copy an event to a calendar of any account (Duplicate copies to the same calendar). */
export const copyCalendarEvent = (
  accountId: string,
  calendarId: string,
  eventId: string,
  toAccountId: string,
  toCalendarId: string,
) =>
  call("copy_calendar_event", {
    accountId,
    calendarId,
    eventId,
    toAccountId,
    toCalendarId,
  });
/**
 * A calendar change as the window saw it, for Send diagnostics: from the user's last answer to Google's confirmation
 * reaching the window (`writeMs`), then to the calendar redrawn with it (`redrawMs`). No titles or ids.
 */
export interface CalendarWriteShown {
  op: "create" | "update" | "move" | "delete" | "copy" | "undo_create" | "respond";
  /** For a repeating event, which occurrences the change covered. */
  scope: EditScope | null;
  /** `not_redrawn`: Google confirmed it, but the calendar couldn't be read again. */
  outcome: "shown" | "not_redrawn" | "failed" | "conflict";
  writeMs: number;
  /** Null when the write failed and nothing was redrawn. */
  redrawMs: number | null;
  totalMs: number;
}
/** Log how long a calendar change took to show. */
export const logCalendarWrite = (report: CalendarWriteShown) =>
  call("log_calendar_write", { report });
/** Answer an invitation (`accepted`, `tentative` or `declined`); guests are always told. */
export const respondToCalendarEvent = (
  accountId: string,
  calendarId: string,
  eventId: string,
  scope: EditScope,
  response: "accepted" | "tentative" | "declined",
  comment?: string | null,
) =>
  call("respond_to_calendar_event", {
    accountId,
    calendarId,
    eventId,
    scope,
    response,
    comment: comment ?? null,
  });
/** Answer the invitation with this iCalendar UID (Mail's invite card), importing `import` if Calendar lacks it. */
export const respondToCalendarInvite = (
  accountId: string,
  icalUid: string,
  response: "accepted" | "tentative" | "declined",
  comment?: string | null,
  importEvent?: Record<string, unknown> | null,
) =>
  call("respond_to_calendar_invite", {
    accountId,
    icalUid,
    response,
    comment: comment ?? null,
    import: importEvent ?? null,
  });

/** A calendar invitation an email carries (Mail's invite card), with the event as it is now on the calendar when cached. */
export interface Invite {
  /** `REQUEST`, `CANCEL`, `REPLY`, `PUBLISH`, … */
  method: string;
  uid: string;
  sequence: number;
  /** The email cancels the event. */
  cancelled: boolean;
  summary: string | null;
  description: string | null;
  location: string | null;
  /** The video call (Meet, Teams, Zoom, Webex, FaceTime, …). */
  meeting: MeetingLink | null;
  start: EventTime;
  /** Exclusive: the day after the last, for an all-day event. */
  end: EventTime;
  allDay: boolean;
  recurrence: string[];
  /** The email is about one changed occurrence of a series, originally at this time. */
  recurrenceId: EventTime | null;
  organizer: { email: string | null; name: string | null; isSelf: boolean } | null;
  attendees: Attendee[];
  /** The event as it is now on the account's calendar (the occurrence, for one occurrence). */
  live: EventDetail | null;
  /** Higher than `sequence`: the email is out of date. */
  liveSequence: number | null;
  /** The event to import when answering an invitation the calendar lacks; null when there's nothing to answer. */
  import: Record<string, unknown> | null;
}
/** The calendar invitation in a message, or null when it has none. May download it from Gmail. */
export const getMessageInvite = (accountId: string, messageId: string) =>
  call("message_invite", { accountId, messageId });

/** One event in an email's calendar file (Mail's Add to calendar dialog). */
export interface FileEvent {
  uid: string;
  summary: string | null;
  location: string | null;
  start: EventTime;
  /** Exclusive: the day after the last, for an all-day event. */
  end: EventTime;
  allDay: boolean;
  repeats: boolean;
  cancelled: boolean;
  /** The account is a guest of this invitation (not its organizer): adding it accepts. */
  invited: boolean;
  /** Where it already is (same iCalendar UID), on any account's calendar. */
  existing: EventRef | null;
  /** For an invitation: the event to import when accepting (`respondToCalendarInvite`). */
  import: Record<string, unknown> | null;
}
/** Every event in an email's calendar file. */
export interface CalendarFile {
  events: FileEvent[];
}
/** What adding a calendar file's events did. */
export interface AddedFileEvents {
  /** The events now on the calendar, in the file's order. */
  events: EventRef[];
  /** How many of them were there already. */
  already: number;
}
/** The events in a message's calendar file: the `.ics` attachment `attachmentId`, else its invitation. May download it. */
export const getCalendarFile = (
  accountId: string,
  messageId: string,
  attachmentId: string | null,
) => call("calendar_file", { accountId, messageId, attachmentId });
/** Adds the events with these UIDs to a calendar as plain copies: no organizer or guests, nobody emailed. */
export const addCalendarFileEvents = (
  file: { accountId: string; messageId: string; attachmentId: string | null },
  targetAccountId: string,
  calendarId: string,
  uids: string[],
) => call("add_calendar_file_events", { ...file, targetAccountId, calendarId, uids });

// ── Event templates (local: saved in Pheeme's database, never sent to Google) ──

export interface TemplateGuest {
  name: string | null;
  address: string;
  optional: boolean;
}
/** What a template fills in: the event's details apart from when it is. */
export interface TemplateFields {
  summary: string;
  allDay: boolean;
  /** Timed: minutes. All-day: days. */
  length: number;
  accountId: string | null;
  calendarId: string | null;
  guests: TemplateGuest[];
  guestsCanModify: boolean;
  guestsCanInviteOthers: boolean;
  guestsCanSeeOtherGuests: boolean;
  /** A new Google Meet link for each event made from it. */
  meet: boolean;
  location: string;
  description: string;
  /** `""`: the calendar's colour. */
  colorId: string;
  remindersDefault: boolean;
  reminders: { method: "popup" | "email"; minutes: number }[];
  transparency: "opaque" | "transparent";
  visibility: "default" | "public" | "private" | "confidential";
}
export interface EventTemplate {
  id: string;
  name: string;
  fields: TemplateFields;
  updatedMs: number;
}

export const listEventTemplates = () => call("event_templates");
/** Rejects with `exists` when the name is taken, unless `replace`. */
export const saveEventTemplate = (name: string, fields: TemplateFields, replace: boolean) =>
  call("save_event_template", { name, fields, replace });
export const renameEventTemplate = (id: string, name: string) =>
  call("rename_event_template", { id, name });
export const deleteEventTemplate = (id: string) => call("delete_event_template", { id });
