// Add to calendar from an email's `.ics` file: which file is open in the dialog, and the rules for
// what adding it does. An invitation the account is a guest of is accepted (the organizer is told);
// anything else goes on the chosen calendar as plain copies that email nobody. Every event in the
// file is offered, so a whole schedule goes in at once.
import { create } from "zustand";
import { toast, toastError } from "../components/ui/Toast";
import {
  type CalendarAccount,
  type CalendarEvent,
  type CalendarFile,
  type FileEvent,
  getCalendarFile,
} from "../lib/tauri";
import { type WritableCalendar, writableCalendars } from "./actions";
import { type PinnedEmail, useCalendarStore } from "./calendarStore";

/** The calendar file of a message: the `.ics` attachment `attachmentId`, else its invitation. */
export interface FileSource extends PinnedEmail {
  attachmentId: string | null;
}

/** What the dialog does. */
export type AddPlan =
  /** One invitation the account is a guest of: accept it on the account's own calendar. */
  | { kind: "accept"; event: FileEvent }
  /** Plain copies of these events on a calendar the user picks. */
  | { kind: "copy"; events: FileEvent[] }
  /** Every event is already on a calendar. */
  | { kind: "there"; event: FileEvent }
  /** Nothing to add: every event is cancelled. */
  | { kind: "none" };

export function planFor(file: CalendarFile): AddPlan {
  const live = file.events.filter((e) => !e.cancelled);
  if (live.length === 0) return { kind: "none" };
  const missing = live.filter((e) => !e.existing);
  if (missing.length === 0) return { kind: "there", event: live[0] };
  const [only] = missing;
  if (file.events.length === 1 && only.invited && only.import)
    return { kind: "accept", event: only };
  return { kind: "copy", events: missing };
}

/** Where copies go first: the receiving account's own calendar, else the first one you can write to. */
export function defaultCalendar(
  accounts: CalendarAccount[] | null,
  accountId: string,
): WritableCalendar | undefined {
  const list = writableCalendars(accounts);
  return (
    list.find((w) => w.account.accountId === accountId && w.calendar.primary) ??
    list.find((w) => w.account.accountId === accountId) ??
    list[0]
  );
}

/** A calendar's name as the pickers show it: the account's address for its own calendar. */
export const calendarName = (w: WritableCalendar) =>
  w.calendar.primary ? w.account.email : w.calendar.summary;

/** The file's event as a calendar event, for the formatting and Open in Calendar the calendar has. */
export function asEvent(e: FileEvent, accountId: string): CalendarEvent {
  return {
    accountId: e.existing?.accountId ?? accountId,
    calendarId: e.existing?.calendarId ?? "",
    id: e.existing?.id ?? `file:${e.uid}`,
    masterId: null,
    summary: e.summary,
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    status: e.cancelled ? "cancelled" : "confirmed",
    selfResponse: "needsAction",
    location: e.location,
    hasConference: false,
    meeting: null,
    colorId: null,
    transparency: null,
    recurring: e.repeats,
    canEdit: false,
    taskLink: null,
  };
}

interface AddFromFileState {
  /** The file the dialog is open on, read. */
  open: { source: FileSource; file: CalendarFile } | null;
  /** The source being read before the dialog opens (a key from {@link sourceKey}). */
  reading: string | null;
  close(): void;
}

export const useAddFromFileStore = create<AddFromFileState>()((set) => ({
  open: null,
  reading: null,
  close: () => set({ open: null }),
}));

export const sourceKey = (s: Pick<FileSource, "messageId" | "attachmentId">) =>
  `${s.messageId}\n${s.attachmentId ?? ""}`;

/**
 * Reads the file, then opens the dialog with everything it shows (so it opens at its final size).
 * While it reads, `reading` names it, for the button that asked to show it's busy.
 */
export async function openAddFromFile(source: FileSource) {
  const store = useAddFromFileStore;
  if (store.getState().reading) return;
  store.setState({ reading: sourceKey(source) });
  try {
    const calendars = useCalendarStore.getState();
    const [file] = await Promise.all([
      getCalendarFile(source.accountId, source.messageId, source.attachmentId),
      calendars.accounts === null ? calendars.loadAccounts() : Promise.resolve(),
    ]);
    if (!file) {
      toast({ title: "No events in this file", description: "There's nothing in it to add." });
      return;
    }
    store.setState({ open: { source, file } });
  } catch (e) {
    toastError(e);
  } finally {
    store.setState({ reading: null });
  }
}
