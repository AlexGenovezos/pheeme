// Calendar mode state: Mail or Calendar in front, the view and the day it shows, every account's
// calendars, and the events of the months around the days on screen, read from the local cache and
// kept, so changing the view or the day draws at once. Mode and view survive a restart; the day
// doesn't (Calendar opens on today, as the website does).
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { subscribeAll } from "../lib/subscriptions";
import {
  CALENDAR_EVENTS,
  type CalendarAccount,
  type CalendarEvent,
  getCalendarAccounts,
  getCalendarEvents,
  getDatedTasks,
  setCalendarHidden,
  toCommandError,
} from "../lib/tauri";
import { useTasksStore } from "../tasks/tasksStore";
import { addDays, dateOf, isValidZone, systemZone } from "./dates";
import { type CalendarView, daysRange, shiftAnchor, visibleDays, windowDays } from "./views";

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

/** The email pinned beside the calendar (Open in Calendar, Create event from email). */
export interface PinnedEmail {
  accountId: string;
  threadId: string;
  /** The message it's about (the invitation's, or the newest). */
  messageId: string;
}

/** Where an event popover is open, and what it shows. */
export interface OpenEvent {
  event: CalendarEvent;
  /** The block that opened it, to sit beside and to return focus to. */
  anchor: HTMLElement | null;
}

/** A UTC ms range `[from, to)` in a zone. */
export interface EventsRange {
  from: number;
  to: number;
  tz: string;
}

const covers = (have: EventsRange | null, want: EventsRange) =>
  have !== null && have.tz === want.tz && have.from <= want.from && have.to >= want.to;

/** A view and the day it's built around. */
interface Place {
  view: CalendarView;
  anchor: string;
}

interface CalendarState extends Prefs {
  /** The day the view is built around. */
  anchor: string;
  /** `null` until the first load. */
  accounts: CalendarAccount[] | null;
  /** The events of `eventsFor` (more than the days on screen); `null` until the first load. */
  events: CalendarEvent[] | null;
  /** The range the events were read for: the months around the days on screen. */
  eventsFor: EventsRange | null;
  loadError: string | null;
  open: OpenEvent | null;
  /** The "Go to date" dialog is open. */
  goToOpen: boolean;
  pinned: PinnedEmail | null;
  /** Minutes past midnight Day and Week open scrolled to (a pinned invitation's time) until Mail is back in front. */
  reveal: number | null;

  setMode(mode: AppMode): void;
  toggleMode(): void;
  setView(view: CalendarView): void;
  /** Show `date` (and switch to `view`, if given); resolves once its events are read. */
  goTo(date: string, view?: CalendarView): Promise<void>;
  today(): void;
  step(dir: 1 | -1): void;
  openEvent(open: OpenEvent | null): void;
  setGoToOpen(open: boolean): void;
  /** Pin an email beside the calendar (null unpins it), and scroll Day and Week to `reveal` minutes. */
  pin(pinned: PinnedEmail | null, reveal?: number | null): void;
  loadAccounts(): Promise<void>;
  /** Read the events around the days on screen (again). */
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
/** Where the calendar is going while it waits for the events there (they weren't in memory). */
let pending: Place | null = null;

export const useCalendarStore = create<CalendarState>((set, get) => {
  const prefs = readPrefs();
  const save = (view = get().view) => writePrefs({ mode: get().mode, view });
  /** The place on screen, or the one it's on its way to. */
  const target = (): Place => pending ?? { view: get().view, anchor: get().anchor };

  /**
   * Show `place`. Its events are read with those of the months either side and kept: when the
   * days are already in memory it shows at once (and reads the new months in the background);
   * otherwise it stays where it is until they're read, then shows with them, never half-filled.
   * `reload` reads the events again even when they're in memory (sync, a write).
   */
  const show = async (place: Place, reload: boolean) => {
    const ticket = ++eventsTicket;
    const s = get();
    const tz = displayZone(s.accounts);
    const weekStart = weekStartOf(s.accounts);
    const screen = { ...daysRange(visibleDays(place.view, place.anchor, weekStart), tz), tz };
    const around = windowDays(place.anchor, weekStart);
    const want = { ...daysRange([around.first, around.last], tz), tz };
    const ready = covers(s.eventsFor, screen);
    if (ready) {
      pending = null;
      if (place.view !== s.view || place.anchor !== s.anchor) set(place);
    } else pending = place;
    const have = s.eventsFor;
    const moved = !have || have.from !== want.from || have.to !== want.to || have.tz !== tz;
    // Dated tasks come along for the same days, so a new view shows them in its first frame too.
    const tasks = useTasksStore.getState();
    const end = addDays(around.last, 1);
    const tasksMoved = tasks.datedFor !== `${around.first}:${end}`;
    if (ready && !moved && !reload && !tasksMoved) return;

    // Read here rather than through the tasks store, so the grid on screen keeps its tasks until
    // these show together with the events. `undefined`: the read failed.
    const datedBefore = tasks.dated;
    const datedRead = tasksMoved
      ? getDatedTasks(around.first, end).then(
          (d) => d ?? [],
          () => undefined,
        )
      : null;
    try {
      const [events, dated] = await Promise.all([
        getCalendarEvents(want.from, want.to, tz),
        datedRead,
      ]);
      if (ticket !== eventsTicket) return;
      pending = null;
      // A task edited or synced meanwhile may be missing from what was read: read again.
      const changed = useTasksStore.getState().dated !== datedBefore;
      if (dated && !changed) useTasksStore.getState().setDated(around.first, end, dated);
      else if (dated !== null) void useTasksStore.getState().loadDated(around.first, end);
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
        ...(ready ? {} : place),
        events,
        eventsFor: want,
        loadError: null,
        open: open && still ? { ...open, event: still } : null,
      });
    } catch (e) {
      if (ticket !== eventsTicket) return;
      pending = null;
      set({ ...(ready ? {} : place), loadError: toCommandError(e).message });
    }
  };

  return {
    ...prefs,
    anchor: dateOf(Date.now(), systemZone()),
    accounts: null,
    events: null,
    eventsFor: null,
    loadError: null,
    open: null,
    goToOpen: false,
    pinned: null,
    reveal: null,

    setMode: (mode) => {
      if (mode === get().mode) return;
      set({ mode, open: null, ...(mode === "mail" ? { reveal: null } : {}) });
      save();
    },
    toggleMode: () => get().setMode(get().mode === "mail" ? "calendar" : "mail"),
    setView: (view) => {
      set({ open: null });
      save(view);
      void show({ view, anchor: target().anchor }, false);
    },
    goTo: (date, view) => {
      set({ open: null });
      if (view) save(view);
      return show({ view: view ?? target().view, anchor: date }, false);
    },
    today: () => void get().goTo(dateOf(Date.now(), displayZone(get().accounts))),
    step: (dir) => {
      const { view, anchor } = target();
      void get().goTo(shiftAnchor(view, anchor, dir));
    },
    openEvent: (open) => set({ open }),
    setGoToOpen: (goToOpen) => set({ goToOpen }),
    pin: (pinned, reveal = null) => set({ pinned, reveal }),

    loadAccounts: async () => {
      const ticket = ++accountsTicket;
      try {
        const accounts = (await getCalendarAccounts()) ?? [];
        if (ticket !== accountsTicket) return;
        const firstLoad = get().accounts === null;
        set({ accounts, loadError: null });
        // Today in the Calendar zone can differ from the computer's.
        if (firstLoad) set({ anchor: dateOf(Date.now(), displayZone(accounts)) });
        // Accounts, zone or week start may have changed what's on screen (a local read).
        void get().loadEvents();
      } catch (e) {
        if (ticket === accountsTicket) set({ loadError: toCommandError(e).message });
      }
    },

    loadEvents: () => show(target(), true),

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
          () => listen(CALENDAR_EVENTS.updated, () => void get().loadAccounts()),
          () => listen(CALENDAR_EVENTS.access, () => void get().loadAccounts()),
        ],
        signal,
      ),
  };
});
