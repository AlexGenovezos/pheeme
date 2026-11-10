// Calendar mode state: Mail or Calendar in front, the view and the day it shows, every account's
// calendars, and the events of the days on screen. Mode and view survive a restart; the day doesn't
// (Calendar opens on today, as the website does).
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { subscribeAll } from "../lib/subscriptions";
import {
  CALENDAR_EVENTS,
  type CalendarAccount,
  type CalendarEvent,
  getCalendarAccounts,
  getCalendarEvents,
  setCalendarHidden,
  toCommandError,
} from "../lib/tauri";
import { dateOf, isValidZone, systemZone } from "./dates";
import { type CalendarView, daysRange, shiftAnchor, visibleDays } from "./views";

export type AppMode = "mail" | "calendar";

export const CALENDAR_PREFS_KEY = "pheeme.calendar";

interface Prefs {
  mode: AppMode;
  view: CalendarView;
}

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readPrefs(store: Pick<Storage, "getItem"> | undefined = storage()): Prefs {
  try {
    const raw = JSON.parse(store?.getItem(CALENDAR_PREFS_KEY) ?? "null") as Partial<Prefs> | null;
    return {
      mode: raw?.mode === "calendar" ? "calendar" : "mail",
      view: raw?.view === "day" || raw?.view === "month" ? raw.view : "week",
    };
  } catch {
    return { mode: "mail", view: "week" };
  }
}

function writePrefs(prefs: Prefs) {
  try {
    storage()?.setItem(CALENDAR_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or blocked: the choice lasts for this session.
  }
}

/** The zone the grid shows: the first account's Google Calendar setting, else the computer's. */
export function displayZone(accounts: CalendarAccount[] | null): string {
  const tz = accounts?.find((a) => a.access.status === "on" && isValidZone(a.timeZone))?.timeZone;
  return tz ?? systemZone();
}

/** The week start from the first account's Calendar settings, else Sunday. */
export function weekStartOf(accounts: CalendarAccount[] | null): number {
  const start = accounts?.find((a) => a.access.status === "on" && a.weekStart != null)?.weekStart;
  return start ?? 0;
}

/** Where an event popover is open, and what it shows. */
export interface OpenEvent {
  event: CalendarEvent;
  /** The block that opened it, to sit beside and to return focus to. */
  anchor: HTMLElement | null;
}

interface CalendarState extends Prefs {
  /** The day the view is built around. */
  anchor: string;
  /** `null` until the first load. */
  accounts: CalendarAccount[] | null;
  /** The events of `eventsFor`'s days; `null` until the first load. */
  events: CalendarEvent[] | null;
  /** The range the events were read for (`from:to:zone`). */
  eventsFor: string | null;
  loadError: string | null;
  open: OpenEvent | null;
  /** The "Go to date" dialog is open. */
  goToOpen: boolean;

  setMode(mode: AppMode): void;
  toggleMode(): void;
  setView(view: CalendarView): void;
  /** Show `date` (and switch to `view`, if given). */
  goTo(date: string, view?: CalendarView): void;
  today(): void;
  step(dir: 1 | -1): void;
  openEvent(open: OpenEvent | null): void;
  setGoToOpen(open: boolean): void;
  loadAccounts(): Promise<void>;
  /** Read the events of the days on screen (again). */
  loadEvents(): Promise<void>;
  setHidden(accountId: string, calendarId: string, hidden: boolean): Promise<void>;
  /** Reload on calendar sync events. Resolves to the unsubscribe function. */
  subscribe(signal?: AbortSignal): Promise<() => void>;
}

/** The days on screen and the zone they're in. */
export function screenDays(s: Pick<CalendarState, "view" | "anchor" | "accounts">) {
  const tz = displayZone(s.accounts);
  return { tz, days: visibleDays(s.view, s.anchor, weekStartOf(s.accounts)) };
}

let accountsTicket = 0;
let eventsTicket = 0;

export const useCalendarStore = create<CalendarState>((set, get) => {
  const prefs = readPrefs();
  const save = () => writePrefs({ mode: get().mode, view: get().view });
  return {
    ...prefs,
    anchor: dateOf(Date.now(), systemZone()),
    accounts: null,
    events: null,
    eventsFor: null,
    loadError: null,
    open: null,
    goToOpen: false,

    setMode: (mode) => {
      if (mode === get().mode) return;
      set({ mode, open: null });
      save();
    },
    toggleMode: () => get().setMode(get().mode === "mail" ? "calendar" : "mail"),
    setView: (view) => {
      set({ view, open: null });
      save();
      void get().loadEvents();
    },
    goTo: (date, view) => {
      set({ anchor: date, open: null, ...(view ? { view } : {}) });
      if (view) save();
      void get().loadEvents();
    },
    today: () => get().goTo(dateOf(Date.now(), displayZone(get().accounts))),
    step: (dir) => get().goTo(shiftAnchor(get().view, get().anchor, dir)),
    openEvent: (open) => set({ open }),
    setGoToOpen: (goToOpen) => set({ goToOpen }),

    loadAccounts: async () => {
      const ticket = ++accountsTicket;
      try {
        const accounts = (await getCalendarAccounts()) ?? [];
        if (ticket !== accountsTicket) return;
        const firstLoad = get().accounts === null;
        const zoneBefore = displayZone(get().accounts);
        set({ accounts, loadError: null });
        // Today in the Calendar zone can differ from the computer's.
        if (firstLoad) set({ anchor: dateOf(Date.now(), displayZone(accounts)) });
        if (firstLoad || zoneBefore !== displayZone(accounts)) void get().loadEvents();
      } catch (e) {
        if (ticket === accountsTicket) set({ loadError: toCommandError(e).message });
      }
    },

    loadEvents: async () => {
      const { tz, days } = screenDays(get());
      const { from, to } = daysRange(days, tz);
      const key = `${from}:${to}:${tz}`;
      const ticket = ++eventsTicket;
      try {
        const events = await getCalendarEvents(from, to, tz);
        if (ticket !== eventsTicket) return;
        // The open popover's event may have moved or gone; keep it only while it's still there.
        const open = get().open;
        const still =
          open &&
          events.find(
            (e) =>
              e.accountId === open.event.accountId &&
              e.calendarId === open.event.calendarId &&
              e.id === open.event.id,
          );
        set({
          events,
          eventsFor: key,
          loadError: null,
          open: open && still ? { ...open, event: still } : null,
        });
      } catch (e) {
        if (ticket === eventsTicket) set({ loadError: toCommandError(e).message });
      }
    },

    setHidden: async (accountId, calendarId, hidden) => {
      const patch = (value: boolean) =>
        set((s) => ({
          accounts:
            s.accounts?.map((a) =>
              a.accountId !== accountId
                ? a
                : {
                    ...a,
                    calendars: a.calendars.map((c) =>
                      c.id === calendarId ? { ...c, hidden: value } : c,
                    ),
                  },
            ) ?? null,
        }));
      patch(hidden);
      try {
        await setCalendarHidden(accountId, calendarId, hidden);
      } catch (e) {
        patch(!hidden);
        set({ loadError: toCommandError(e).message });
        return;
      }
      await get().loadEvents();
    },

    subscribe: (signal) =>
      subscribeAll(
        [
          () =>
            listen(CALENDAR_EVENTS.updated, () => {
              void get().loadAccounts();
              void get().loadEvents();
            }),
          () => listen(CALENDAR_EVENTS.access, () => void get().loadAccounts()),
        ],
        signal,
      ),
  };
});
