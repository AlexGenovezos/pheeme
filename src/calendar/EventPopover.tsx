// The event popover: what, when, where, Join (any video call), guests and their answers (each opens
// their person card), and Yes / Maybe / No.
// It opens beside the event clicked and reads the full event from the local cache.
import {
  Check,
  CircleHelp,
  Clock,
  EllipsisVertical,
  ExternalLink,
  Globe,
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
import { showPerson } from "../contacts/personStore";
import { IconButton } from "../components/ui/IconButton";
import { Menu, type MenuItem } from "../components/ui/Menu";
import { toastError } from "../components/ui/Toast";
import { placeBeside } from "../components/ui/placement";
import { useDismiss } from "../components/ui/usePopover";
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
import { addDays, dateOf, formatDay, formatTime, isValidZone } from "./dates";
import { plainText } from "./eventForm";
import { noteDismiss } from "./drag";
import { eventTitle, useCalendarLookup } from "./EventBlock";
import { joinLabel, joinMeeting, locationIsCall } from "./meeting";
import { EventWeather } from "../weather/EventWeather";
import { linkify } from "../mail/linkify";
import { AnswerRadios } from "./AnswerRadios";
import { type Answer, answerTally, answerWord } from "./rsvp";
import { type OtherZone, placeName, useZoneSettings } from "./zoneSettings";
import { dayShift, offsetMinutes, zoneCity } from "./zones";
import "../components/ui/Surface.css";

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

export interface ZoneLine {
  zone: string;
  /** "Athens", or the user's label for the zone. */
  name: string;
  /** "9:00 PM – 10:00 PM" in the zone. */
  when: string;
  /** "+1 day" when the event starts on another day there, else "". */
  shift: string;
  /** The zone the event was made in (Google keeps one with every timed event). */
  eventZone: boolean;
}

/**
 * A timed event's time in the user's other zones, and in its own zone when that keeps another
 * clock than the calendar's. Nothing for an all-day event.
 */
export function zoneLines(e: CalendarEvent, tz: string, others: OtherZone[]): ZoneLine[] {
  const start = e.start.ms;
  if (e.allDay || start == null) return [];
  const startDay = dateOf(start, tz);
  const zones: { zone: string; name: string; eventZone: boolean }[] = [];
  const own = e.start.timeZone;
  if (isValidZone(own) && offsetMinutes(start, own) !== offsetMinutes(start, tz))
    zones.push({ zone: own, name: zoneCity(own), eventZone: true });
  for (const z of others) {
    if (z.zone === tz) continue;
    const same = zones.find((x) => x.zone === z.zone);
    if (same) same.name = placeName(z);
    else zones.push({ zone: z.zone, name: placeName(z), eventZone: false });
  }
  return zones.map(({ zone, name, eventZone }) => ({
    zone,
    name,
    eventZone,
    when:
      e.end.ms == null
        ? formatTime(start, zone)
        : `${formatTime(start, zone)} – ${formatTime(e.end.ms, zone)}`,
    shift: dayShift(startDay, dateOf(start, zone)),
  }));
}

/** The event's time in other zones, one line each, under its time. */
function OtherZoneTimes({ event, tz }: { event: CalendarEvent; tz: string }) {
  const others = useZoneSettings((s) => s.zones);
  const lines = zoneLines(event, tz, others);
  if (lines.length === 0) return null;
  return (
    <div className="cal-pop__row cal-pop__row--top">
      <Globe aria-hidden="true" />
      <ul className="cal-pop__zones" aria-label="In other time zones">
        {lines.map((l) => (
          <li key={l.zone} title={l.zone}>
            {l.when} {l.name}
            {l.shift && <span className="cal-pop__muted"> {l.shift}</span>}
            {l.eventZone && <span className="cal-pop__muted"> · event's time zone</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function guestSummary(guests: Attendee[]): string {
  const tally = answerTally(guests);
  return `${guests.length} ${guests.length === 1 ? "guest" : "guests"}${tally ? ` · ${tally}` : ""}`;
}

/** A guest's or organizer's name; anyone but you opens their person card, closing the popover. */
function PersonName({
  accountId,
  person,
  className,
}: {
  accountId: string;
  person: { email: string | null; name: string | null; isSelf: boolean };
  className?: string;
}) {
  const shown = person.name || person.email;
  const email = person.email;
  if (!email || person.isSelf)
    return (
      <span className={className} title={email ?? undefined}>
        {shown}
        {person.isSelf && " (you)"}
      </span>
    );
  return (
    <button
      type="button"
      className={cx("person-link", className)}
      title={email}
      aria-label={`View contact ${shown}`}
      onClick={() => {
        close();
        showPerson(accountId, { address: email, name: person.name });
      }}
    >
      {shown}
    </button>
  );
}

function GuestRow({ accountId, guest }: { accountId: string; guest: Attendee }) {
  const response = guest.response ?? "needsAction";
  const Icon = response === "accepted" ? Check : response === "declined" ? X : CircleHelp;
  return (
    <li className={cx("cal-pop__guest", `cal-pop__guest--${response}`)}>
      <Icon aria-label={answerWord[response] ?? response} />
      <PersonName accountId={accountId} person={guest} className="cal-pop__guest-name" />
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
        <AnswerRadios shown={pending ?? current} pending={pending !== null} onChoose={choose} />
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
  const editShortcut = useKeybinding("calendar.edit");
  const deleteShortcut = useKeybinding("calendar.delete");
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
  const joinShortcut = useKeybinding("calendar.join");
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
    setPos(placeBeside(at, box, { width: window.innerWidth, height: window.innerHeight }));
  }, [open, ready, load]);

  // Focus moves in when it opens and back to the event when it closes. Only on opening (another
  // event is a new body, by its key): `open` is a new object after every events read (a sync, an
  // answer to the invite), and that mustn't pull focus away from what the user is on.
  const anchor = open.anchor;
  useEffect(() => {
    if (!ready) return;
    ref.current?.querySelector<HTMLElement>(".cal-pop__close")?.focus();
  }, [anchor, ready]);
  useEffect(() => {
    if (!anchor) return;
    return () => {
      if (anchor.isConnected && !useCalendarStore.getState().open) anchor.focus();
    };
  }, [anchor]);

  useDismiss(ref, {
    onOutside: (e) => {
      noteDismiss(e);
      close();
    },
  });

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
      className="cal-pop popover-surface"
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
            onClick={() => void openExternal(detail.htmlLink!).catch(toastError)}
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
      <OtherZoneTimes event={event} tz={tz} />
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
        <>
          <div className="cal-pop__row">
            <MapPin aria-hidden="true" />
            <span className="selectable">{event.location}</span>
          </div>
          <EventWeather event={event} tz={tz} />
        </>
      )}
      {guests.length > 0 && (
        <div className="cal-pop__row cal-pop__row--top">
          <Users aria-hidden="true" />
          <div className="cal-pop__guests">
            <span>{guestSummary(guests)}</span>
            <ul>
              {guests.map((g, i) => (
                <GuestRow key={g.email ?? i} accountId={event.accountId} guest={g} />
              ))}
            </ul>
          </div>
        </div>
      )}
      {description && <p className="cal-pop__description selectable">{linkify(description)}</p>}
      <p className="cal-pop__calendar">
        <span className="cal-pop__dot" style={{ background }} aria-hidden="true" />
        {/* One flex item, so the organizer's name sits in the sentence. */}
        <span>
          {calendar?.summary ?? event.calendarId}
          {detail?.organizer && !detail.organizer.isSelf && (
            <>
              {" "}
              · Organized by <PersonName accountId={event.accountId} person={detail.organizer} />
            </>
          )}
        </span>
      </p>
      {detail?.canRsvp && <Rsvp detail={detail} />}
    </div>
  );
}
