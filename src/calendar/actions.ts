// What creating, editing, moving, deleting and copying an event does: the website's questions
// (which events of a series, whether to email the guests), the write straight to Google, then
// the grid read again. A refused write snaps back and says why; `conflict` (changed elsewhere)
// reloads first.
import { toast } from "../components/ui/Toast";
import {
  type CalendarAccount,
  type CalendarEvent,
  type CalendarInfo,
  calendarSyncNow,
  copyCalendarEvent,
  createCalendarEvent,
  deleteCalendarEvent,
  type EditScope,
  type EventDetail,
  type EventEdit,
  type EventTime,
  getCalendarEventDetail,
  moveCalendarEvent,
  type SendUpdates,
  toCommandError,
  updateCalendarEvent,
} from "../lib/tauri";
import { displayZone, screenDays, useCalendarStore } from "./calendarStore";
import { dateOf, wallClock, zonedMs } from "./dates";
import { ask, type EditorSpec, useEditStore } from "./editStore";
import { eventKey, eventTitle } from "./EventBlock";
import {
  type EventForm,
  formEdit,
  formFromDetail,
  formProblem,
  hasOtherGuests,
  isEmptyEdit,
  newForm,
} from "./eventForm";

const calendars = () => useCalendarStore.getState();
const edits = () => useEditStore.getState();

export interface WritableCalendar {
  account: CalendarAccount;
  calendar: CalendarInfo;
}

/** Calendars new events can go on: owner or writer, of accounts whose calendar access is on. */
export function writableCalendars(accounts: CalendarAccount[] | null): WritableCalendar[] {
  return (accounts ?? [])
    .filter((a) => a.access.status === "on")
    .flatMap((account) =>
      account.calendars
        .filter((c) => c.accessRole === "owner" || c.accessRole === "writer")
        .sort((a, b) => Number(b.primary) - Number(a.primary))
        .map((calendar) => ({ account, calendar })),
    );
}

const LAST_CALENDAR_KEY = "pheeme.calendar.lastCalendar";

function rememberCalendar(accountId: string, calendarId: string) {
  try {
    localStorage.setItem(LAST_CALENDAR_KEY, JSON.stringify([accountId, calendarId]));
  } catch {
    // Storage blocked: the next new event uses the first calendar again.
  }
}

/** Where a new event goes: the calendar used last, else the first account's own calendar. */
function defaultCalendar(): WritableCalendar | undefined {
  const list = writableCalendars(calendars().accounts);
  try {
    const [accountId, calendarId] = JSON.parse(localStorage.getItem(LAST_CALENDAR_KEY) ?? "[]");
    const last = list.find(
      (w) => w.account.accountId === accountId && w.calendar.id === calendarId,
    );
    if (last) return last;
  } catch {
    // Unreadable: fall back to the first.
  }
  return list[0];
}

/** Say why a write failed. Changed elsewhere: read the account's calendars again first. */
function reportError(e: unknown, what: string, accountId?: string) {
  const err = toCommandError(e);
  if (err.code === "conflict") {
    toast({
      title: "This event was changed somewhere else",
      description: "Pheeme loaded the latest version. Check it and try again.",
      tone: "danger",
    });
    if (accountId) void calendarSyncNow(accountId).catch(() => {});
    void calendars().loadEvents();
    return;
  }
  toast({ title: what, description: err.message, tone: "danger" });
}

// ── New events ───────────────────────────────────────────────────────────────

/** Start a new event at these times (from the grid); false if there's no calendar to put it on. */
export function startDraft(
  times: { allDay: boolean; start?: number; end?: number; startDate?: string; endDate?: string },
  phase: "dragging" | "ready" = "ready",
): boolean {
  const target = defaultCalendar();
  if (!target) return false;
  calendars().openEvent(null);
  const zone = displayZone(calendars().accounts);
  const form = newForm({
    ...times,
    zone,
    accountId: target.account.accountId,
    calendarId: target.calendar.id,
  });
  useEditStore.setState({ draft: { form, phase } });
  return true;
}

/** Create (`c`, the Create button): the next half hour today if it's on screen, else 9 AM on the day shown. */
export function startDraftNow() {
  const { tz, days } = screenDays(calendars());
  const now = wallClock(Date.now(), tz);
  const day = days.includes(now.date) ? now.date : calendars().anchor;
  const minutes =
    day === now.date ? Math.min(Math.ceil((now.minutes + 1) / 30) * 30, 23 * 60) : 9 * 60;
  const start = zonedMs(day, minutes, tz);
  if (!startDraft({ allDay: false, start, end: start + 60 * 60_000 }))
    toast({
      title: "No calendar to add events to",
      description: "Allow calendar access for an account first.",
    });
}

export const updateDraft = (form: EventForm) =>
  useEditStore.setState((s) => (s.draft ? { draft: { ...s.draft, form } } : {}));

export const cancelDraft = () => useEditStore.setState({ draft: null });

/** Save the quick-create popover's event. */
export async function saveDraft(): Promise<boolean> {
  const draft = edits().draft;
  if (!draft) return false;
  const problem = formProblem(draft.form);
  if (problem) {
    toast({ title: problem, tone: "danger" });
    return false;
  }
  return saveNew(draft.form, () => cancelDraft());
}

async function saveNew(form: EventForm, done: () => void): Promise<boolean> {
  const account = calendars().accounts?.find((a) => a.accountId === form.accountId);
  let sendUpdates: SendUpdates = "none";
  if (hasOtherGuests(form.guests, account?.email)) {
    const answer = await askSendUpdates("invite");
    if (!answer) return false;
    sendUpdates = answer;
  }
  try {
    await createCalendarEvent(form.accountId, form.calendarId, formEdit(form, null), sendUpdates);
  } catch (e) {
    reportError(e, "Couldn't create the event");
    return false;
  }
  rememberCalendar(form.accountId, form.calendarId);
  await calendars().loadEvents();
  done();
  return true;
}

/** "More options": the quick-create's event in the full editor. */
export function openDraftInEditor() {
  const draft = edits().draft;
  if (!draft) return;
  useEditStore.setState({
    draft: null,
    editor: { form: draft.form, initial: null, event: null, detail: null },
  });
}

// ── The editor ───────────────────────────────────────────────────────────────

async function loadDetail(event: CalendarEvent): Promise<EventDetail | null> {
  try {
    return await getCalendarEventDetail(event.accountId, event.calendarId, event.id);
  } catch (e) {
    reportError(e, "Couldn't open the event");
    return null;
  }
}

/** Edit (`e`): the event in the full editor, if this account may change it. */
export async function editEvent(event: CalendarEvent) {
  const detail = await loadDetail(event);
  if (!detail) return;
  if (!detail.canEdit) {
    toast({ title: "Only the organizer can change this event." });
    return;
  }
  const form = formFromDetail(detail, displayZone(calendars().accounts));
  calendars().openEvent(null);
  useEditStore.setState({ editor: { form, initial: form, event, detail } });
}

/** Duplicate: a copy of the event in the editor, saved as a new event on a calendar you can write to. */
export async function duplicateEvent(event: CalendarEvent) {
  const detail = await loadDetail(event);
  if (!detail) return;
  const form = formFromDetail(detail, displayZone(calendars().accounts));
  const writable = writableCalendars(calendars().accounts);
  const same = writable.find(
    (w) => w.account.accountId === event.accountId && w.calendar.id === event.calendarId,
  );
  const target = same ?? defaultCalendar();
  if (!target) return;
  calendars().openEvent(null);
  useEditStore.setState({
    editor: {
      // A new event from this one (a series from this occurrence on); no Meet link of its own yet.
      form: {
        ...form,
        accountId: target.account.accountId,
        calendarId: target.calendar.id,
        meet: false,
        extraLines: [],
      },
      initial: null,
      event: null,
      detail: null,
    },
  });
}

export const closeEditor = () => useEditStore.setState({ editor: null });

const SCOPE_OPTIONS = [
  { value: "this", label: "This event" },
  { value: "following", label: "This and following events" },
  { value: "all", label: "All events" },
];

/** The website's question for a repeating event; null if the user backed out. */
export async function askScope(
  action: "edit" | "delete",
  allowThis = true,
): Promise<EditScope | null> {
  const answer = await ask({
    title: action === "delete" ? "Delete repeating event" : "Edit repeating event",
    kind: "choice",
    options: SCOPE_OPTIONS.filter((o) => allowThis || o.value !== "this"),
  });
  return answer as EditScope | null;
}

/** Whether Google should email the guests; null if the user backed out. */
export async function askSendUpdates(
  kind: "invite" | "update" | "cancel",
): Promise<SendUpdates | null> {
  const answer = await ask({
    title:
      kind === "invite"
        ? "Send invitation emails to guests?"
        : kind === "cancel"
          ? "Send cancellation emails to guests?"
          : "Send update emails to guests?",
    message:
      kind === "invite"
        ? "Guests get an email with the invitation."
        : kind === "cancel"
          ? "Guests get an email saying the event was cancelled."
          : "Guests get an email about the change.",
    kind: "buttons",
    options: [
      { value: "back", label: "Back" },
      { value: "none", label: "Don't send" },
      { value: "all", label: "Send" },
    ],
  });
  return answer === "all" || answer === "none" ? answer : null;
}

/** Save the editor. Resolves to an error to show in it, or null when it saved (and closed). */
export async function saveEditor(spec: EditorSpec, form: EventForm): Promise<string | null> {
  const problem = formProblem(form);
  if (problem) return problem;
  if (!spec.event || !spec.initial) {
    await saveNew(form, closeEditor);
    return null;
  }
  const event = spec.event;
  const edit = formEdit(form, spec.initial);
  const moved = form.calendarId !== spec.initial.calendarId;
  if (isEmptyEdit(edit) && !moved) {
    closeEditor();
    return null;
  }
  let scope: EditScope = "this";
  if (event.recurring && !isEmptyEdit(edit)) {
    // Repeat can only change for the whole series or from here on.
    const answer = await askScope("edit", edit.recurrence === undefined);
    if (!answer) return "";
    scope = answer;
  }
  const self = calendars().accounts?.find((a) => a.accountId === event.accountId)?.email;
  let sendUpdates: SendUpdates = "none";
  if (hasOtherGuests([...spec.initial.guests, ...form.guests], self)) {
    const answer = await askSendUpdates("update");
    if (!answer) return "";
    sendUpdates = answer;
  }
  try {
    let id = event.id;
    if (!isEmptyEdit(edit)) {
      const saved = await updateCalendarEvent(
        event.accountId,
        event.calendarId,
        event.id,
        scope,
        edit,
        sendUpdates,
      );
      id = saved.id;
    }
    if (moved)
      await moveCalendarEvent(event.accountId, event.calendarId, id, form.calendarId, sendUpdates);
  } catch (e) {
    const err = toCommandError(e);
    if (err.code === "conflict") {
      reportError(e, "", event.accountId);
      closeEditor();
      return null;
    }
    return err.message;
  }
  closeEditor();
  await calendars().loadEvents();
  return null;
}

// ── Moving, deleting and copying from the grid and the popover ──────────────

/** Drop an event at a new time (drag to move or resize). */
export async function moveEvent(event: CalendarEvent, start: EventTime, end: EventTime) {
  const key = eventKey(event);
  useEditStore.setState({ moving: { key, start, end } });
  const settle = () =>
    useEditStore.setState((s) => (s.moving?.key === key ? { moving: null } : {}));
  let scope: EditScope = "this";
  if (event.recurring) {
    const answer = await askScope("edit");
    if (!answer) return settle();
    scope = answer;
  }
  const detail = await loadDetail(event);
  if (!detail) return settle();
  const self = calendars().accounts?.find((a) => a.accountId === event.accountId)?.email;
  const guests = detail.attendees
    .filter((a) => !a.resource && a.email)
    .map((a) => ({ name: a.name, address: a.email!, optional: a.optional }));
  let sendUpdates: SendUpdates = "none";
  if (hasOtherGuests(guests, self)) {
    const answer = await askSendUpdates("update");
    if (!answer) return settle();
    sendUpdates = answer;
  }
  const edit: EventEdit = event.allDay
    ? { start: { date: start.date }, end: { date: end.date } }
    : {
        start: { ms: start.ms, timeZone: event.start.timeZone },
        end: { ms: end.ms, timeZone: event.end.timeZone ?? event.start.timeZone },
      };
  try {
    await updateCalendarEvent(
      event.accountId,
      event.calendarId,
      event.id,
      scope,
      edit,
      sendUpdates,
    );
    await calendars().loadEvents();
  } catch (e) {
    reportError(e, "Couldn't move the event", event.accountId);
  }
  settle();
}

/** Delete (Delete/Backspace, the popover's bin): asks for a series and about guests first. */
export async function deleteEvent(event: CalendarEvent) {
  const detail = await loadDetail(event);
  if (!detail) return;
  if (!detail.canDelete) {
    toast({ title: "You can't delete events from this calendar." });
    return;
  }
  let scope: EditScope = "this";
  if (event.recurring) {
    const answer = await askScope("delete");
    if (!answer) return;
    scope = answer;
  }
  const self = calendars().accounts?.find((a) => a.accountId === event.accountId)?.email;
  const organizer = detail.organizer?.isSelf ?? true;
  const guests = detail.attendees
    .filter((a) => !a.resource && a.email)
    .map((a) => ({ name: a.name, address: a.email!, optional: a.optional }));
  let sendUpdates: SendUpdates = "none";
  if (organizer && hasOtherGuests(guests, self)) {
    const answer = await askSendUpdates("cancel");
    if (!answer) return;
    sendUpdates = answer;
  }
  const key = eventKey(event);
  calendars().openEvent(null);
  useEditStore.setState((s) => ({ removed: [...s.removed, key] }));
  try {
    await deleteCalendarEvent(event.accountId, event.calendarId, event.id, scope, sendUpdates);
    await calendars().loadEvents();
    toast({ title: `Deleted “${eventTitle(event)}”` });
  } catch (e) {
    reportError(e, "Couldn't delete the event", event.accountId);
  }
  useEditStore.setState((s) => ({ removed: s.removed.filter((k) => k !== key) }));
}

/** Copy to another calendar (any account's). */
export async function copyEvent(event: CalendarEvent, to: WritableCalendar) {
  try {
    await copyCalendarEvent(
      event.accountId,
      event.calendarId,
      event.id,
      to.account.accountId,
      to.calendar.id,
    );
  } catch (e) {
    reportError(e, "Couldn't copy the event");
    return;
  }
  await calendars().loadEvents();
  const name = to.calendar.primary ? to.account.email : to.calendar.summary;
  toast({ title: `Copied to ${name}` });
}

/** The open event, for the `e` and Delete shortcuts. */
export const openEventNow = () => calendars().open?.event ?? null;

/** Jump to an event's day and open it (search results). */
export async function revealEvent(event: CalendarEvent) {
  const tz = displayZone(calendars().accounts);
  const day = event.start.date ?? dateOf(event.start.ms ?? Date.now(), tz);
  useEditStore.setState({ search: null });
  await calendars().goTo(day);
  const key = eventKey(event);
  const shown = calendars().events?.find((e) => eventKey(e) === key) ?? event;
  // After the grid has drawn the day, so the popover sits beside the event.
  requestAnimationFrame(() => {
    const anchor =
      [...document.querySelectorAll<HTMLElement>("[data-event-key]")].find(
        (el) => el.dataset.eventKey === key,
      ) ?? null;
    calendars().openEvent({ event: shown, anchor });
  });
}
