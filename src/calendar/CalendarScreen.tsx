// Calendar mode: the calendar sidebar beside a Day, Week or Month view of every account's
// calendars, with the event popover over it.
import { ChevronLeft, ChevronRight, PanelLeftOpen, Search } from "lucide-react";
import { type CSSProperties, type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { DateField } from "../components/ui/DateField";
import { describeShortcut } from "../keyboard/format";
import { useCommands, useKeybinding } from "../keyboard/useCommands";
import { createSubscriptionScope } from "../lib/subscriptions";
import { type CalendarEvent, calendarSyncNow, setCalendarForeground } from "../lib/tauri";
import { overlayTitleBar, dragRegion } from "../shell/chrome";
import { Divider } from "../shell/Divider";
import { useSidebarFit } from "../shell/sidebarFit";
import { useWidth } from "../lib/useWidth";
import { useAccountStore } from "../store/accountStore";
import { PANE, sidebarLayout, useUiStore } from "../store/uiStore";
import {
  AllowButton,
  CALENDAR_API_URL,
  CheckAgainButton,
  needsAllow,
  openApiPage,
  TASKS_API_URL,
} from "./AccessControls";
import { deleteEvent, editEvent, openEventNow, openQuickAdd } from "./actions";
import { CalendarSearch } from "./CalendarSearch";
import { CalendarSidebar } from "./CalendarSidebar";
import { displayZone, screenDays, useCalendarStore, weekStartOf } from "./calendarStore";
import { dateOf, formatDay } from "./dates";
import { DRAFT_ID, useEditStore } from "./editStore";
import { EditPrompt } from "./EditPrompt";
import { eventKey } from "./EventBlock";
import { EventEditor } from "./EventEditor";
import { type EventForm, formTimes } from "./eventForm";
import { EventPopover } from "./EventPopover";
import { QuickAdd } from "./QuickAdd";
import { QuickCreate } from "./QuickCreate";
import { MonthGrid } from "./MonthGrid";
import { PinnedEmail } from "./PinnedEmail";
import { TimeGrid } from "./TimeGrid";
import { type CalendarView, viewTitle } from "./views";
import { useNow } from "./useNow";
import "./calendar.css";
import "./editing.css";
import "./invite.css";

const VIEW_OPTIONS = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
] as const;

function Toolbar({ title }: { title: string }) {
  const view = useCalendarStore((s) => s.view);
  const accounts = useCalendarStore((s) => s.accounts);
  const collapsed = useUiStore((s) => sidebarLayout(s) !== "expanded");
  const sidebarShortcut = useKeybinding("view.toggleSidebar", "mod+b");
  const todayShortcut = useKeybinding("calendar.today", "t");
  const prevShortcut = useKeybinding("calendar.previous", "k");
  const nextShortcut = useKeybinding("calendar.next", "j");
  const searchShortcut = useKeybinding("calendar.search", "/");
  const store = useCalendarStore.getState;
  const today = formatDay(dateOf(useNow(), displayZone(accounts)), {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const unit = view === "day" ? "day" : view === "week" ? "week" : "month";
  return (
    <div
      className="toolbar toolbar--view cal-toolbar"
      data-sidebar-collapsed={collapsed || undefined}
      {...dragRegion}
    >
      {collapsed && (
        <IconButton
          label="Show sidebar"
          data-sidebar-toggle=""
          shortcut={sidebarShortcut}
          icon={<PanelLeftOpen />}
          onClick={() => useUiStore.getState().toggleSidebar()}
        />
      )}
      <Button
        size="sm"
        title={todayShortcut ? `${today} (${describeShortcut(todayShortcut)})` : today}
        onClick={() => store().today()}
      >
        Today
      </Button>
      <IconButton
        label={`Previous ${unit}`}
        shortcut={prevShortcut}
        icon={<ChevronLeft />}
        onClick={() => store().step(-1)}
      />
      <IconButton
        label={`Next ${unit}`}
        shortcut={nextShortcut}
        icon={<ChevronRight />}
        onClick={() => store().step(1)}
      />
      <h1 className="toolbar__title cal-toolbar__title" aria-live="polite">
        {title}
      </h1>
      <span className="toolbar__spacer" {...dragRegion} />
      <IconButton
        label="Search events"
        shortcut={searchShortcut}
        icon={<Search />}
        onClick={() => useEditStore.setState({ search: "" })}
      />
      <SegmentedControl
        label="View"
        value={view}
        options={VIEW_OPTIONS}
        onChange={(v: CalendarView) => store().setView(v)}
      />
    </div>
  );
}

/** Shown in place of the grid until at least one account has allowed calendar access. */
function FirstOpen() {
  const accounts = useCalendarStore((s) => s.accounts) ?? [];
  return (
    <div className="cal-first">
      <div className="cal-first__content">
        <h2 className="cal-first__title">Your Google Calendar, in Pheeme</h2>
        <p className="cal-first__lead">
          Pheeme shows every account's calendars together and keeps them in step with Google. Each
          account needs two things from your own Google Cloud project.
        </p>
        <ol className="cal-first__steps">
          <li>
            <h3>Turn on the Calendar and Tasks APIs</h3>
            <p>
              Open each one in your Google Cloud project, check it's the project you made for
              Pheeme, then click Enable. Skip this if you already did.
            </p>
            <div className="cal-first__buttons">
              <Button size="sm" onClick={() => openApiPage(CALENDAR_API_URL)}>
                Open Calendar API
              </Button>
              <Button size="sm" onClick={() => openApiPage(TASKS_API_URL)}>
                Open Tasks API
              </Button>
            </div>
          </li>
          <li>
            <h3>Allow calendar access</h3>
            <p>
              Google asks you to let Pheeme see and edit your calendars and tasks. Your mail stays
              as it is.
            </p>
            <ul className="cal-first__accounts">
              {accounts.map((a) => (
                <li key={a.accountId} className="cal-first__account">
                  <span className="cal-first__email">{a.email}</span>
                  {needsAllow(a) ? (
                    <AllowButton account={a} />
                  ) : a.access.status === "api_disabled" ? (
                    <span className="cal-access__allow">
                      <span className="cal-first__note">The Calendar API is still off.</span>
                      <CheckAgainButton account={a} label="Check again" />
                    </span>
                  ) : (
                    <span className="cal-access__allow">
                      <span className="cal-first__note">
                        {a.access.message ?? "Couldn't reach Google Calendar."}
                      </span>
                      <CheckAgainButton account={a} label="Try again" />
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </li>
        </ol>
      </div>
    </div>
  );
}

function GoToDate() {
  const open = useCalendarStore((s) => s.goToOpen);
  return open ? <GoToDateForm /> : null;
}

function GoToDateForm() {
  const [value] = useState(() => useCalendarStore.getState().anchor);
  const input = useRef<HTMLButtonElement>(null);
  useEffect(() => input.current?.focus(), []);
  const close = () => useCalendarStore.getState().setGoToOpen(false);
  const go = (date: string) => {
    useCalendarStore.getState().goTo(date);
    close();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    go(value);
  };
  return (
    <div className="cal-goto__scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <form
        className="cal-goto"
        role="dialog"
        aria-label="Go to date"
        data-owns-keys=""
        onSubmit={submit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
      >
        <span className="cal-goto__label" id="cal-goto-date">
          Go to date
        </span>
        {/* Opens on the month grid: arrows and Enter (or a click) go straight to the day. */}
        <DateField
          ref={input}
          aria-labelledby="cal-goto-date"
          className="cal-goto__input"
          value={value}
          weekStart={weekStartOf(useCalendarStore.getState().accounts)}
          defaultOpen
          onChange={go}
        />
        <Button type="submit" size="sm" variant="primary">
          Go
        </Button>
      </form>
    </div>
  );
}

/** Delete the open event (Delete, Backspace). */
function removeOpen() {
  const event = openEventNow();
  if (event) void deleteEvent(event);
}

/** The new event as the grid draws it. */
function draftEvent(form: EventForm): CalendarEvent {
  const { start, end } = formTimes(form);
  const time = (t: typeof start) => ({
    ms: t?.ms ?? null,
    date: t?.date ?? null,
    timeZone: t?.timeZone ?? null,
  });
  return {
    accountId: form.accountId,
    calendarId: form.calendarId,
    id: DRAFT_ID,
    masterId: null,
    summary: form.summary.trim() || null,
    start: time(start),
    end: time(end),
    allDay: form.allDay,
    status: "confirmed",
    selfResponse: null,
    location: null,
    hasConference: false,
    colorId: form.colorId || null,
    transparency: form.transparency,
    recurring: false,
    canEdit: false,
  };
}

/** The events as drawn: without those being deleted, moved ones at their new times, and the new one. */
function useShownEvents(events: CalendarEvent[] | null): CalendarEvent[] | null {
  const draft = useEditStore((s) => s.draft?.form ?? null);
  const moving = useEditStore((s) => s.moving);
  const removed = useEditStore((s) => s.removed);
  return useMemo(() => {
    if (events === null) return null;
    let list = events;
    if (removed.length) list = list.filter((e) => !removed.includes(eventKey(e)));
    if (moving)
      list = list.map((e) =>
        eventKey(e) === moving.key ? { ...e, start: moving.start, end: moving.end } : e,
      );
    return draft ? [...list, draftEvent(draft)] : list;
  }, [events, draft, moving, removed]);
}

function useCalendarCommands() {
  const store = useCalendarStore.getState;
  // Edit and Delete act on the open event: listed in the palette only while one is open.
  const noEventOpen = useCalendarStore((s) => s.open === null);
  const syncAll = () => {
    for (const a of store().accounts ?? [])
      if (a.access.status === "on") void calendarSyncNow(a.accountId).catch(() => {});
  };
  useCommands([
    {
      id: "calendar.day",
      title: "Day view",
      group: "Calendar",
      shortcut: "d",
      run: () => store().setView("day"),
    },
    {
      id: "calendar.week",
      title: "Week view",
      group: "Calendar",
      shortcut: "w",
      run: () => store().setView("week"),
    },
    {
      id: "calendar.month",
      title: "Month view",
      group: "Calendar",
      shortcut: "m",
      run: () => store().setView("month"),
    },
    {
      id: "calendar.today",
      title: "Go to today",
      group: "Calendar",
      shortcut: "t",
      run: () => store().today(),
    },
    {
      id: "calendar.next",
      title: "Next period",
      group: "Calendar",
      shortcut: "j",
      run: () => store().step(1),
    },
    {
      id: "calendar.previous",
      title: "Previous period",
      group: "Calendar",
      shortcut: "k",
      run: () => store().step(-1),
    },
    {
      id: "calendar.next-alt",
      title: "Next period",
      group: "Calendar",
      shortcut: "n",
      hidden: true,
      run: () => store().step(1),
    },
    {
      id: "calendar.previous-alt",
      title: "Previous period",
      group: "Calendar",
      shortcut: "p",
      hidden: true,
      run: () => store().step(-1),
    },
    {
      id: "calendar.goto",
      title: "Go to date…",
      group: "Calendar",
      shortcut: "g",
      run: () => store().setGoToOpen(true),
    },
    {
      id: "calendar.create",
      title: "Create event",
      group: "Calendar",
      shortcut: "c",
      keywords: ["new event", "add", "quick add", "task", "todo"],
      run: openQuickAdd,
    },
    {
      id: "calendar.edit",
      title: "Edit event",
      group: "Calendar",
      shortcut: "e",
      hidden: noEventOpen,
      run: () => {
        const event = openEventNow();
        if (event) void editEvent(event);
      },
    },
    {
      id: "calendar.delete",
      title: "Delete event",
      group: "Calendar",
      shortcut: "delete",
      hidden: noEventOpen,
      run: removeOpen,
    },
    {
      id: "calendar.delete-alt",
      title: "Delete event",
      group: "Calendar",
      shortcut: "backspace",
      hidden: true,
      run: removeOpen,
    },
    {
      id: "calendar.search",
      title: "Search events",
      group: "Calendar",
      shortcut: "/",
      keywords: ["find"],
      run: () => useEditStore.setState({ search: "" }),
    },
    {
      id: "calendar.sync",
      title: "Update calendars now",
      group: "Calendar",
      keywords: ["sync", "refresh"],
      run: syncAll,
    },
  ]);
}

/** Load calendars and events, follow sync, and tell the backend Calendar is in front. */
function useCalendarData() {
  const accountIds = useAccountStore((s) => s.accounts.map((a) => a.id).join("\n"));
  useEffect(() => {
    void useCalendarStore.getState().loadAccounts();
  }, [accountIds]);
  useEffect(() => {
    const scope = createSubscriptionScope();
    scope
      .add((signal) => useCalendarStore.getState().subscribe(signal))
      .catch((err: unknown) => console.warn("calendar event listener failed", err));
    // Events are read by loadAccounts (above), once the zone and week start are known.
    void setCalendarForeground(true).catch(() => {});
    return () => {
      scope.dispose();
      void setCalendarForeground(false).catch(() => {});
    };
  }, []);
}

/** The pinned email column's width (--pinned-email-width). */
function pinnedEmailWidth(): number {
  return (
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--pinned-email-width"),
    ) || 0
  );
}

export function CalendarScreen() {
  useCalendarCommands();
  useCalendarData();
  const ref = useRef<HTMLDivElement>(null);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const pinned = useCalendarStore((s) => s.pinned !== null);
  const aside = useRef<HTMLElement>(null);
  // The calendar needs its own minimum, plus the email pinned beside it.
  const layout = useSidebarFit(
    aside,
    useWidth(ref),
    PANE.viewMin + (pinned ? pinnedEmailWidth() : 0),
  );
  const { setSidebarWidth, resetSidebarWidth } = useUiStore.getState();
  const view = useCalendarStore((s) => s.view);
  const anchor = useCalendarStore((s) => s.anchor);
  const accounts = useCalendarStore((s) => s.accounts);
  const events = useShownEvents(useCalendarStore((s) => s.events));
  const loadError = useCalendarStore((s) => s.loadError);
  const searching = useEditStore((s) => s.search !== null);
  const { tz, days } = screenDays({ view, anchor, accounts });

  const anyOn = accounts?.some((a) => a.access.status === "on") ?? true;
  const style = {
    "--shell-sidebar-w": `${sidebarWidth}px`,
    "--shell-view-min": `${PANE.viewMin}px`,
  } as CSSProperties;

  return (
    <div
      ref={ref}
      className="shell"
      data-mode="calendar"
      style={style}
      data-sidebar={layout}
      data-overlay-titlebar={overlayTitleBar || undefined}
    >
      <aside
        ref={aside}
        className="shell__sidebar"
        aria-label="Sidebar"
        aria-hidden={layout === "collapsed" || undefined}
      >
        <CalendarSidebar />
      </aside>
      {layout === "expanded" && (
        <Divider
          className="shell__divider--sidebar"
          label="Resize sidebar"
          value={sidebarWidth}
          min={PANE.sidebarMin}
          max={PANE.sidebarMax}
          onResize={setSidebarWidth}
          onReset={resetSidebarWidth}
        />
      )}
      <main className="shell__view cal-main" aria-label="Calendar">
        <Toolbar title={viewTitle(view, anchor, days)} />
        {loadError && (
          <p className="cal-main__error" role="alert">
            {loadError}
          </p>
        )}
        <div className="cal-main__body">
          <PinnedEmail />
          <div className="cal-main__grid">
            {!anyOn ? (
              <FirstOpen />
            ) : searching ? (
              <CalendarSearch />
            ) : view === "month" ? (
              <MonthGrid days={days} anchor={anchor} tz={tz} events={events} />
            ) : (
              <TimeGrid key={view} days={days} tz={tz} events={events} />
            )}
          </div>
        </div>
      </main>
      <EventPopover />
      <QuickCreate />
      <QuickAdd />
      <EventEditor />
      <EditPrompt />
      <GoToDate />
    </div>
  );
}
