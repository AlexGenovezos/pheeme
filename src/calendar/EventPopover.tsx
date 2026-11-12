// The event popover: what, when, where, Join (any video call), guests and their answers, and Yes / Maybe / No.
// It opens beside the event clicked and reads the full event from the local cache.
import {
  Check,
  CircleHelp,
  Clock,
  EllipsisVertical,
  ExternalLink,
  MapPin,
  Pencil,
  Repeat,
  Trash2,
  Users,
  Video,
  X,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import { Menu, type MenuItem } from "../components/ui/Menu";
import { describeShortcut } from "../keyboard/format";
import { useKeybinding } from "../keyboard/useCommands";
import {
  type Attendee,
  type CalendarEvent,
  type EditScope,
  type EventDetail,
  getCalendarEventDetail,
  openExternal,
  respondToCalendarEvent,
  toCommandError,
} from "../lib/tauri";
import { cx } from "../lib/utils";
import { copyEvent, deleteEvent, duplicateEvent, editEvent, writableCalendars } from "./actions";
import { displayZone, type OpenEvent, useCalendarStore } from "./calendarStore";
import { eventColors } from "./colors";
import { addDays, dateOf, formatDay, formatTime } from "./dates";
import { plainText } from "./eventForm";
import { noteDismiss } from "./drag";
import { eventTitle, useCalendarLookup } from "./EventBlock";
import { joinLabel, joinMeeting, locationIsCall } from "./meeting";

type Answer = "accepted" | "tentative" | "declined";

const ANSWERS: { value: Answer; label: string }[] = [
  { value: "accepted", label: "Yes" },
  { value: "tentative", label: "Maybe" },
  { value: "declined", label: "No" },
];

const SCOPES: { value: EditScope; label: string }[] = [
  { value: "this", label: "This event" },
  { value: "all", label: "All events" },
];

/** "Wednesday, November 11 · 2:00 – 3:00 PM", or the dates of an all-day event. */
export function describeWhen(e: CalendarEvent, tz: string): string {
  const long: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric" };
  if (e.allDay && e.start.date) {
    const last = e.end.date ? addDays(e.end.date, -1) : e.start.date;
    if (last <= e.start.date) return formatDay(e.start.date, long);
    return `${formatDay(e.start.date, { month: "long", day: "numeric" })} – ${formatDay(last, { month: "long", day: "numeric", year: "numeric" })}`;
  }
  if (e.start.ms == null) return "";
  const startDay = dateOf(e.start.ms, tz);
  const start = formatTime(e.start.ms, tz);
  if (e.end.ms == null) return `${formatDay(startDay, long)} · ${start}`;
  const endDay = dateOf(e.end.ms - 1, tz);
  const end = formatTime(e.end.ms, tz);
  if (endDay === startDay) return `${formatDay(startDay, long)} · ${start} – ${end}`;
  return `${formatDay(startDay, { month: "short", day: "numeric" })}, ${start} – ${formatDay(endDay, { month: "short", day: "numeric" })}, ${end}`;
}

const answerWord: Record<string, string> = {
  accepted: "Yes",
  tentative: "Maybe",
  declined: "No",
  needsAction: "Awaiting",
};

function guestSummary(guests: Attendee[]): string {
  const count = (r: string) => guests.filter((g) => (g.response ?? "needsAction") === r).length;
  const parts = [
    [count("accepted"), "yes"],
    [count("tentative"), "maybe"],
    [count("declined"), "no"],
    [count("needsAction"), "awaiting"],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, w]) => `${n} ${w}`);
  return `${guests.length} ${guests.length === 1 ? "guest" : "guests"}${parts.length ? ` · ${parts.join(", ")}` : ""}`;
}

function GuestRow({ guest }: { guest: Attendee }) {
  const response = guest.response ?? "needsAction";
  const Icon = response === "accepted" ? Check : response === "declined" ? X : CircleHelp;
  return (
    <li className={cx("cal-pop__guest", `cal-pop__guest--${response}`)}>
      <Icon aria-label={answerWord[response] ?? response} />
      <span className="cal-pop__guest-name" title={guest.email ?? undefined}>
        {guest.name || guest.email}
        {guest.isSelf && " (you)"}
      </span>
      {guest.organizer && <span className="cal-pop__guest-role">Organizer</span>}
      {guest.optional && !guest.organizer && <span className="cal-pop__guest-role">Optional</span>}
    </li>
  );
}

function Rsvp({ detail }: { detail: EventDetail }) {
  const [pending, setPending] = useState<Answer | null>(null);
  const [asking, setAsking] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What Google accepted, shown until the cache catches up.
  const [answered, setAnswered] = useState<Answer | null>(null);
  const current = answered ?? detail.selfResponse;

  const send = async (response: Answer, scope: EditScope) => {
    setAsking(null);
    setPending(response);
    setError(null);
    try {
      await respondToCalendarEvent(detail.accountId, detail.calendarId, detail.id, scope, response);
      setAnswered(response);
      await useCalendarStore.getState().loadEvents();
    } catch (e) {
      setError(toCommandError(e).message);
    } finally {
      setPending(null);
    }
  };

  const choose = (response: Answer) => {
    if (response === current && !detail.recurring) return;
    if (detail.recurring) setAsking(response);
    else void send(response, "this");
  };

  return (
    <div className="cal-pop__rsvp">
      <div className="cal-pop__rsvp-row">
        <span className="cal-pop__rsvp-label">Going?</span>
        <div role="radiogroup" aria-label="Your answer" className="cal-pop__answers">
          {ANSWERS.map((a) => (
            <button
              key={a.value}
              type="button"
              role="radio"
              aria-checked={(pending ?? current) === a.value}
              className="cal-pop__answer"
              disabled={pending !== null}
              onClick={() => choose(a.value)}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
      {asking && (
        <div className="cal-pop__scope" role="group" aria-label="Answer for">
          {SCOPES.map((s) => (
            <Button key={s.value} size="sm" onClick={() => void send(asking, s.value)}>
              {s.label}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setAsking(null)}>
            Cancel
          </Button>
        </div>
      )}
      {error && (
        <p className="cal-pop__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const close = () => useCalendarStore.getState().openEvent(null);

/** Edit, delete, and Options (duplicate, copy to another calendar), where this account may. */
function EventTools({ event }: { event: CalendarEvent }) {
  const accounts = useCalendarStore((s) => s.accounts);
  const lookup = useCalendarLookup();
  const editShortcut = useKeybinding("calendar.edit", "e");
  const deleteShortcut = useKeybinding("calendar.delete", "delete");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const role = lookup(event)?.accessRole;
  const canDelete = role === "owner" || role === "writer";
  const targets = writableCalendars(accounts);
  const items: MenuItem[] = [
    {
      id: "duplicate",
      label: "Duplicate",
      disabled: targets.length === 0,
      onSelect: () => void duplicateEvent(event),
    },
    ...targets
      .filter(
        (t) => !(t.account.accountId === event.accountId && t.calendar.id === event.calendarId),
      )
      .map<MenuItem>((t) => ({
        id: `copy:${t.account.accountId}\n${t.calendar.id}`,
        label: `Copy to ${t.calendar.primary ? t.account.email : `${t.calendar.summary} (${t.account.email})`}`,
        onSelect: () => void copyEvent(event, t),
      })),
  ];
  return (
    <>
      {event.canEdit && (
        <IconButton
          size="sm"
          label="Edit event"
          shortcut={editShortcut}
          icon={<Pencil />}
          onClick={() => void editEvent(event)}
        />
      )}
      {canDelete && (
        <IconButton
          size="sm"
          label="Delete event"
          shortcut={deleteShortcut}
          icon={<Trash2 />}
          onClick={() => void deleteEvent(event)}
        />
      )}
      <IconButton
        size="sm"
        label="Options"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        icon={<EllipsisVertical />}
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setMenu({ x: box.left, y: box.bottom + 4 });
        }}
      />
      {menu && (
        <Menu
          aria-label="Event options"
          items={items}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

type Load =
  | { kind: "loading" }
  | { kind: "ready"; detail: EventDetail }
  | { kind: "failed"; message: string };

/** The open event's popover; a new event starts afresh (its own load and position). */
export function EventPopover() {
  const open = useCalendarStore((s) => s.open);
  if (!open) return null;
  const e = open.event;
  return <PopoverBody key={`${e.accountId}\n${e.calendarId}\n${e.id}`} open={open} />;
}

function PopoverBody({ open }: { open: OpenEvent }) {
  const accounts = useCalendarStore((s) => s.accounts);
  const tz = displayZone(accounts);
  const lookup = useCalendarLookup();
  const joinShortcut = useKeybinding("calendar.join", "shift+j");
  const ref = useRef<HTMLDivElement>(null);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const event = open.event;

  // Read the detail again whenever the event (or the cache behind it) changes.
  useEffect(() => {
    let live = true;
    getCalendarEventDetail(event.accountId, event.calendarId, event.id).then(
      (detail) => live && setLoad({ kind: "ready", detail }),
      (e: unknown) => live && setLoad({ kind: "failed", message: toCommandError(e).message }),
    );
    return () => {
      live = false;
    };
  }, [event]);

  // Beside the block: to its right if there's room, else its left; clamped to the window.
  const ready = load.kind !== "loading";
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !ready) return;
    const box = el.getBoundingClientRect();
    const at = open.anchor?.isConnected ? open.anchor.getBoundingClientRect() : null;
    const gap = 8;
    let left = window.innerWidth / 2 - box.width / 2;
    let top = window.innerHeight / 3 - box.height / 3;
    if (at) {
      left = at.right + gap;
      if (left + box.width > window.innerWidth - gap) left = at.left - gap - box.width;
      top = at.top;
    }
    left = Math.max(gap, Math.min(left, window.innerWidth - box.width - gap));
    top = Math.max(gap, Math.min(top, window.innerHeight - box.height - gap));
    setPos({ left, top });
  }, [open, ready, load]);

  // Focus moves in when it opens and back to the event when it closes.
  useEffect(() => {
    if (!ready) return;
    ref.current?.querySelector<HTMLElement>(".cal-pop__close")?.focus();
  }, [open, ready]);
  const anchor = open.anchor;
  useEffect(() => {
    if (!anchor) return;
    return () => {
      if (anchor.isConnected && !useCalendarStore.getState().open) anchor.focus();
    };
  }, [anchor]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      noteDismiss(e);
      close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  const calendar = lookup(event);
  const detail = load.kind === "ready" ? load.detail : null;
  const { background } = eventColors(event, calendar);
  const guests = detail?.attendees.filter((a) => !a.resource) ?? [];
  const description = detail?.description ? plainText(detail.description) : "";
  // From the listed event, so Join is there from the first frame.
  const meeting = event.meeting;

  // Not a `data-owns-keys` region: `e` and Delete act on this event through the command registry.
  return (
    <div
      ref={ref}
      className="cal-pop"
      role="dialog"
      aria-label={eventTitle(event)}
      style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }}
      onKeyDown={onKeyDown}
    >
      <div className="cal-pop__tools">
        <EventTools event={event} />
        {detail?.htmlLink && (
          <IconButton
            size="sm"
            label="Open in Google Calendar"
            icon={<ExternalLink />}
            onClick={() => void openExternal(detail.htmlLink!).catch(() => {})}
          />
        )}
        <IconButton
          size="sm"
          className="cal-pop__close"
          label="Close"
          icon={<X />}
          onClick={close}
        />
      </div>
      <div className="cal-pop__head">
        <span className="cal-pop__swatch" style={{ background }} aria-hidden="true" />
        <h2
          className={cx(
            "cal-pop__title",
            event.selfResponse === "declined" && "cal-pop__title--declined",
          )}
        >
          {eventTitle(event)}
        </h2>
      </div>
      <div className="cal-pop__row">
        <Clock aria-hidden="true" />
        <span>
          {describeWhen(event, tz)}
          {event.recurring && (
            <span className="cal-pop__muted">
              {" "}
              <Repeat aria-hidden="true" className="cal-pop__inline-icon" /> Repeats
            </span>
          )}
        </span>
      </div>
      {load.kind === "failed" && (
        <p className="cal-pop__error" role="alert">
          {load.message}
        </p>
      )}
      {meeting && (
        <div className="cal-pop__row">
          <Video aria-hidden="true" />
          <Button
            size="sm"
            variant="primary"
            title={joinShortcut ? `Join (${describeShortcut(joinShortcut)})` : undefined}
            onClick={() => joinMeeting(meeting)}
          >
            {joinLabel(meeting)}
          </Button>
        </div>
      )}
      {event.location && !locationIsCall(event.location, meeting) && (
        <div className="cal-pop__row">
          <MapPin aria-hidden="true" />
          <span className="selectable">{event.location}</span>
        </div>
      )}
      {guests.length > 0 && (
        <div className="cal-pop__row cal-pop__row--top">
          <Users aria-hidden="true" />
          <div className="cal-pop__guests">
            <span>{guestSummary(guests)}</span>
            <ul>
              {guests.map((g, i) => (
                <GuestRow key={g.email ?? i} guest={g} />
              ))}
            </ul>
          </div>
        </div>
      )}
      {description && <p className="cal-pop__description selectable">{description}</p>}
      <p className="cal-pop__calendar">
        <span className="cal-pop__dot" style={{ background }} aria-hidden="true" />
        {calendar?.summary ?? event.calendarId}
        {detail?.organizer && !detail.organizer.isSelf && (
          <> · Organized by {detail.organizer.name || detail.organizer.email}</>
        )}
      </p>
      {detail?.canRsvp && <Rsvp detail={detail} />}
    </div>
  );
}
