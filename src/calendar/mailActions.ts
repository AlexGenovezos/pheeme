// Calendar from inside Mail: Open … in Calendar (the day of an invitation, with its email pinned
// beside the grid), Back to Mail, and Create event from email (the editor, filled in from the email).
import { toast } from "../components/ui/Toast";
import type { CalendarEvent } from "../lib/tauri";
import { parseThreadKey, threadKey } from "../mail/mailboxes";
import { useThreadStore } from "../store/threadStore";
import { useUiStore } from "../store/uiStore";
import { writableCalendars } from "./actions";
import { displayZone, type PinnedEmail, useCalendarStore } from "./calendarStore";
import { wallClock } from "./dates";
import { useEditStore } from "./editStore";
import { formFromEmail } from "./fromEmail";
import { startDay } from "./invite";

const calendar = () => useCalendarStore.getState();

export const CREATE_EVENT_COMMAND = "conversation.create-event";
/** Shift+E: E archives, and Calendar's own E (edit) only runs in Calendar mode. */
export const CREATE_EVENT_SHORTCUT = "shift+e";

/** Calendar mode on the event's day (keeping the view), scrolled to its time, with the email pinned. */
export function openInCalendar(pinned: PinnedEmail, event: CalendarEvent) {
  const tz = displayZone(calendar().accounts);
  const reveal = event.start.ms != null ? wallClock(event.start.ms, tz).minutes : null;
  calendar().pin(pinned, reveal);
  calendar().setMode("calendar");
  void calendar().goTo(startDay(event, tz));
}

/** Mail in front again, on the pinned conversation. */
export function backToMail() {
  const pinned = calendar().pinned;
  calendar().setMode("mail");
  if (pinned) useUiStore.getState().setOpenThread(threadKey(pinned.accountId, pinned.threadId));
}

/** The open conversation's detail, loading it if it isn't cached. */
async function openDetail() {
  const key = useUiStore.getState().openThread;
  if (!key) return null;
  const threads = useThreadStore.getState();
  if (!threads.details.has(key)) await threads.load(key);
  const detail = useThreadStore.getState().details.get(key);
  return detail ? { key, detail } : null;
}

/**
 * Create event from email: the editor over Calendar mode, filled in from the open conversation (title,
 * guests, a link back, the time it mentions), on the receiving account's calendar, with the email pinned.
 */
export async function createEventFromEmail() {
  const open = await openDetail();
  if (!open) {
    toast({ title: "Open a conversation first" });
    return;
  }
  const { accountId } = parseThreadKey(open.key);
  if (calendar().accounts === null) await calendar().loadAccounts();
  const accounts = calendar().accounts;
  const writable = writableCalendars(accounts);
  // The receiving account's own calendar; else any the user can write to.
  const target = writable.find((w) => w.account.accountId === accountId) ?? writable[0];
  if (!target) {
    toast({
      title: "No calendar to add events to",
      description: "Allow calendar access for this account first.",
    });
    calendar().setMode("calendar");
    return;
  }
  const message = open.detail.messages[open.detail.messages.length - 1];
  if (!message) return;
  const email = accounts?.find((a) => a.accountId === accountId)?.email ?? target.account.email;
  const tz = displayZone(accounts);
  const { form } = formFromEmail(open.detail, message, {
    email,
    accountId: target.account.accountId,
    calendarId: target.calendar.id,
    tz,
    now: Date.now(),
  });
  calendar().pin(
    { accountId, threadId: open.detail.thread.id, messageId: message.id },
    form.allDay ? null : form.startMinutes,
  );
  calendar().setMode("calendar");
  void calendar().goTo(form.startDate);
  useEditStore.setState({
    draft: null,
    editor: { form, initial: null, event: null, detail: null },
  });
}
