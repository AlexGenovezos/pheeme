import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { toast } from "../components/ui/Toast";
import { stopQuietly } from "../lib/tauri";
import { openAndMarkRead } from "../mail/actions";
import { CATEGORIES, categoryMailbox, threadKey } from "../mail/mailboxes";
import { useModStore } from "../mods/store";
import { useSettingsStore } from "../settings/settingsStore";
import { useAccountStore } from "../store/accountStore";
import { useUiStore } from "../store/uiStore";
import { revealEvent } from "../calendar/actions";
import { useCalendarStore } from "../calendar/calendarStore";
import { getCalendarEventDetail } from "../lib/tauri";
import {
  takeNotificationTarget,
  type EventTarget,
  type NotifyTarget,
  type ThreadTarget,
} from "./api";

export function openNotificationTarget(target: NotifyTarget): boolean {
  if (!useAccountStore.getState().accounts.some((a) => a.id === target.accountId)) return false;
  useSettingsStore.getState().close();
  useModStore.getState().openPanel(null);
  if (target.kind === "event") void openEvent(target);
  else openThread(target);
  return true;
}

/** A reminder: Calendar mode on the event's day, with its popover open. */
async function openEvent(target: EventTarget) {
  const calendar = useCalendarStore.getState();
  calendar.setMode("calendar");
  try {
    // The first load moves the view to today, so let it finish before going to the event's day.
    // Calendar's own mount starts a load too, and only the latest one lands: wait for the store.
    if (!calendar.accounts) await firstCalendarLoad();
    const event = await getCalendarEventDetail(target.accountId, target.calendarId, target.eventId);
    await revealEvent(event);
  } catch (error) {
    // Deleted since the reminder: Calendar mode is still the right place to land.
    console.warn("Could not open the reminder's event", error);
  }
}

/** Resolves once calendar accounts are loaded (or the load failed), whichever load did it. */
function firstCalendarLoad(): Promise<void> {
  return new Promise((resolve) => {
    const done = (s: ReturnType<typeof useCalendarStore.getState>) =>
      s.accounts !== null || s.loadError !== null;
    const stop = useCalendarStore.subscribe((s) => {
      if (!done(s)) return;
      stop();
      resolve();
    });
    void useCalendarStore.getState().loadAccounts();
  });
}

/**
 * New mail: the account's Primary inbox (only Primary mail notifies) with the conversation open and marked read, as
 * opening it from the list would. It still opens if another device archived it after delivery.
 */
function openThread(target: ThreadTarget) {
  useCalendarStore.getState().setMode("mail");
  useUiStore.getState().setMailbox(categoryMailbox(target.accountId, CATEGORIES[0].labelId));
  openAndMarkRead(threadKey(target.accountId, target.threadId), 1, { unread: true });
}

export function useDesktopEvents(ready: boolean, showMail: () => void) {
  useEffect(() => {
    if (!ready) return;
    let stopped = false;
    const stops: (() => void)[] = [];
    const keep = (stop: () => void) => (stopped ? stopQuietly(stop) : stops.push(stop));
    const drain = async () => {
      if (stopped) return;
      try {
        const target = await takeNotificationTarget();
        // Once claimed, complete navigation even if StrictMode has replaced this subscription.
        if (target && openNotificationTarget(target)) showMail();
      } catch (error) {
        console.warn("Could not open notification", error);
      }
    };
    listen("desktop:open-thread", () => void drain()).then((stop) => {
      keep(stop);
      void drain(); // Claims a click received before the webview was ready.
    }, console.warn);
    listen<string>("desktop:error", ({ payload }) =>
      toast({ title: payload, tone: "danger" }),
    ).then(keep, console.warn);
    return () => {
      stopped = true;
      stops.forEach(stopQuietly);
    };
  }, [ready, showMail]);
}
