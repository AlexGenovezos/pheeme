// Mail's invite card: an email's calendar invitation at the top of the conversation. What, when,
// where (Join for a meeting link), who and how they answered, Yes / Maybe / No, and a mini day view
// of the hours around it from every shown calendar, with clashes named. It shows the event as it is
// now on the calendar when Pheeme has it, and says when the email is out of date or cancelled.
import { listen } from "@tauri-apps/api/event";
import { CalendarDays, Clock, ExternalLink, MapPin, Users, Video } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { Button } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { TextInput } from "../components/ui/TextInput";
import {
  type Attendee,
  CALENDAR_EVENTS,
  type CalendarEvent,
  type EditScope,
  getCalendarEvents,
  getMessageInvite,
  type Invite,
  openExternal,
  respondToCalendarEvent,
  respondToCalendarInvite,
  toCommandError,
} from "../lib/tauri";
import { createSubscriptionScope } from "../lib/subscriptions";
import { cx } from "../lib/utils";
import { AllowButton, needsAllow } from "./AccessControls";
import { displayZone, type PinnedEmail, useCalendarStore } from "./calendarStore";
import { eventColors } from "./colors";
import { addDays, dateOf, formatDay, formatHour, wallClock, zonedMs } from "./dates";
import { eventTitle, useCalendarLookup } from "./EventBlock";
import { describeWhen } from "./EventPopover";
import {
  canAnswer,
  clashes,
  clashText,
  inviteNotice,
  isSameEvent,
  miniWindow,
  selfAnswer,
  shownEvent,
  startDay,
} from "./invite";
import { layoutDay, MIN_EVENT_MINUTES } from "./layout";
import { openInCalendar } from "./mailActions";
import "./calendar.css";
import "./invite.css";

type Answer = "accepted" | "tentative" | "declined";

const ANSWERS: { value: Answer; label: string }[] = [
  { value: "accepted", label: "Yes" },
  { value: "tentative", label: "Maybe" },
  { value: "declined", label: "No" },
];

type Load =
  | { kind: "loading" }
  | { kind: "ready"; invite: Invite | null }
  | { kind: "failed"; message: string };

/** The message's invitation, read again when the account's calendar changes (an answer, a sync). */
function useInvite(accountId: string, messageId: string): Load {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    getMessageInvite(accountId, messageId).then(
      (invite) => live && setLoad({ kind: "ready", invite }),
      (e: unknown) => live && setLoad({ kind: "failed", message: toCommandError(e).message }),
    );
    return () => {
      live = false;
    };
  }, [accountId, messageId, version]);
  useEffect(() => {
    const reread = (e: { payload: { accountId?: string } }) => {
      if (!e.payload?.accountId || e.payload.accountId === accountId) setVersion((v) => v + 1);
    };
    const scope = createSubscriptionScope();
    for (const name of [CALENDAR_EVENTS.updated, CALENDAR_EVENTS.access])
      scope.add(() => listen(name, reread)).catch(() => {});
    return () => scope.dispose();
  }, [accountId]);
  return load;
}

/** Every account's calendars, read once in Mail (Calendar mode keeps them current itself). */
function useCalendarAccounts() {
  const accounts = useCalendarStore((s) => s.accounts);
  useEffect(() => {
    if (accounts === null) void useCalendarStore.getState().loadAccounts();
  }, [accounts]);
  return accounts;
}

/** "Morgan Lee (organizer) · 4 guests: 2 yes, 1 maybe, 1 awaiting". */
function whoLine(organizer: Invite["organizer"], guests: Attendee[]): string {
  const people = guests.filter((g) => !g.resource);
  const count = (r: string) => people.filter((g) => (g.response ?? "needsAction") === r).length;
  const answers = [
    [count("accepted"), "yes"],
    [count("tentative"), "maybe"],
    [count("declined"), "no"],
    [count("needsAction"), "awaiting"],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, w]) => `${n} ${w}`)
    .join(", ");
  const by = organizer
    ? `${organizer.isSelf ? "You" : organizer.name || organizer.email} (organizer)`
    : null;
  const guestsPart = people.length
    ? `${people.length} ${people.length === 1 ? "guest" : "guests"}${answers ? `: ${answers}` : ""}`
    : null;
  return [by, guestsPart].filter(Boolean).join(" · ") || "No guest list";
}

/** "Join with Google Meet", "Join with Zoom", … from the link's host. */
function joinLabel(url: string): string {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();
  if (host.endsWith("meet.google.com")) return "Join with Google Meet";
  if (host.includes("teams.")) return "Join with Teams";
  if (host.includes("zoom.")) return "Join with Zoom";
  if (host.includes("facetime.")) return "Join with FaceTime";
  return "Join meeting";
}

/** `YYYYMMDDTHHMMSSZ`, as instance ids spell a start. */
function instanceSuffix(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/** Answer on the calendar's copy when Pheeme has it; otherwise by UID, importing the invitation if needed. */
async function sendAnswer(
  invite: Invite,
  accountId: string,
  response: Answer,
  comment: string | null,
  onlyFirst: boolean,
) {
  const live = invite.live;
  if (!live) {
    await respondToCalendarInvite(accountId, invite.uid, response, comment, invite.import);
    return;
  }
  let id = live.id;
  let scope: EditScope = invite.recurrenceId || live.masterId ? "this" : "all";
  // "Only this event" of a series: its first occurrence, the one the email shows.
  if (onlyFirst && live.recurrence.length > 0 && !live.masterId) {
    const start = live.start.ms;
    id =
      start != null
        ? `${live.id}_${instanceSuffix(start)}`
        : `${live.id}_${live.start.date?.replace(/-/g, "")}`;
    scope = "this";
  }
  await respondToCalendarEvent(live.accountId, live.calendarId, id, scope, response, comment);
}

function AnswerRow({
  invite,
  accountId,
  compact,
}: {
  invite: Invite | null;
  accountId: string;
  compact: boolean;
}) {
  const accounts = useCalendarStore((s) => s.accounts);
  const account = accounts?.find((a) => a.accountId === accountId);
  const [pending, setPending] = useState<Answer | null>(null);
  const [answered, setAnswered] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [note, setNote] = useState("");
  const [onlyFirst, setOnlyFirst] = useState(false);
  const current = answered ?? (invite ? selfAnswer(invite) : null);
  const series = Boolean(
    invite?.live && invite.live.recurrence.length > 0 && !invite.live.masterId,
  );

  const send = async (response: Answer, withNote: boolean) => {
    if (!invite) return;
    setPending(response);
    setError(null);
    try {
      await sendAnswer(
        invite,
        accountId,
        response,
        withNote ? note.trim() || null : null,
        onlyFirst,
      );
      setAnswered(response);
      setMore(false);
      void useCalendarStore.getState().loadEvents();
    } catch (e) {
      setError(toCommandError(e).message);
    } finally {
      setPending(null);
    }
  };

  let body;
  if (!invite || !accounts) {
    body = (
      <>
        <Skeleton width="7em" />
        <Skeleton width="12em" />
      </>
    );
  } else if (account && needsAllow(account)) {
    body = (
      <>
        <span className="invite-card__muted">Allow calendar access to answer here.</span>
        <AllowButton account={account} />
      </>
    );
  } else if (!canAnswer(invite)) {
    const why = invite.organizer?.isSelf
      ? "You're the organizer."
      : invite.cancelled || invite.live?.status === "cancelled"
        ? "Nothing to answer."
        : invite.method === "REPLY"
          ? "A guest's answer to your event."
          : "This change isn't on your calendar yet.";
    body = <span className="invite-card__muted">{why}</span>;
  } else {
    body = (
      <>
        <span className="invite-card__going">Going?</span>
        <div role="radiogroup" aria-label="Your answer" className="cal-pop__answers">
          {ANSWERS.map((a) => (
            <button
              key={a.value}
              type="button"
              role="radio"
              aria-checked={(pending ?? current) === a.value}
              className="cal-pop__answer"
              disabled={pending !== null}
              onClick={() => void send(a.value, false)}
            >
              {a.label}
            </button>
          ))}
        </div>
        <Button size="sm" variant="ghost" aria-expanded={more} onClick={() => setMore(!more)}>
          More options
        </Button>
      </>
    );
  }

  return (
    <div className="invite-card__answer">
      <div className={cx("invite-card__answer-row", compact && "invite-card__answer-row--wrap")}>
        {body}
      </div>
      {more && invite && (
        <div className="invite-card__more" role="group" aria-label="Answer with a note">
          <TextInput
            className="invite-card__note"
            placeholder="Add a note for the organizer"
            aria-label="Note for the organizer"
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
          />
          {series && (
            <label className="invite-card__only">
              <input
                type="checkbox"
                checked={onlyFirst}
                onChange={(e) => setOnlyFirst(e.currentTarget.checked)}
              />
              Only for{" "}
              {formatDay(startDay(invite.live!, displayZone(accounts)), {
                weekday: "short",
                month: "short",
                day: "numeric",
              })}
            </label>
          )}
          <div className="invite-card__more-buttons">
            {ANSWERS.map((a) => (
              <Button
                key={a.value}
                size="sm"
                disabled={pending !== null}
                onClick={() => void send(a.value, true)}
              >
                {`Send “${a.label}”`}
              </Button>
            ))}
            {invite.live?.htmlLink && (
              <Button
                size="sm"
                variant="ghost"
                icon={<ExternalLink />}
                onClick={() => void openExternal(invite.live!.htmlLink!).catch(() => {})}
              >
                Open in Google Calendar
              </Button>
            )}
          </div>
        </div>
      )}
      {error && (
        <p className="invite-card__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The hours around the invitation: the user's events and the invitation (dashed), clashes named below. */
function MiniDay({ event }: { event: CalendarEvent | null }) {
  const accounts = useCalendarStore((s) => s.accounts);
  const lookup = useCalendarLookup();
  const tz = displayZone(accounts);
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const day = event ? startDay(event, tz) : null;
  const anyOn = accounts?.some((a) => a.access.status === "on") ?? false;

  // Read the day again after every sync (the accounts' sync times change).
  const synced = accounts?.map((a) => a.access.syncedAt).join() ?? null;
  useEffect(() => {
    if (!day || !anyOn || synced === null) return;
    const stale = new AbortController();
    const from = zonedMs(day, 0, tz);
    const to = zonedMs(addDays(day, 1), 0, tz);
    getCalendarEvents(from, to, tz).then(
      (list) => !stale.signal.aborted && setEvents(list),
      () => !stale.signal.aborted && setEvents([]),
    );
    return () => stale.abort();
  }, [day, tz, anyOn, synced]);

  const others = useMemo(
    () => (event ? (events ?? []).filter((e) => !isSameEvent(e, event)) : []),
    [events, event],
  );
  const clash = event ? clashes(others, event) : [];
  const timed = event && !event.allDay && event.start.ms != null;
  // The end on the same day, or midnight when it runs into the next.
  const endMinutes =
    timed && event.end.ms != null && dateOf(event.end.ms - 1, tz) === day
      ? wallClock(event.end.ms, tz).minutes
      : 24 * 60;
  const span = timed
    ? miniWindow(wallClock(event.start.ms!, tz).minutes, Math.max(endMinutes, 1))
    : { from: 8 * 60, to: 12 * 60 };
  const blocks = useMemo(
    () =>
      day && event ? layoutDay([...others, { ...event, id: `${event.id}\ninvite` }], day, tz) : [],
    [others, event, day, tz],
  );
  // Positions are fractions of the view's height (`--invite-mini-day-height`).
  const at = (minutes: number) => `${((minutes - span.from) / (span.to - span.from)) * 100}%`;
  const hours: number[] = [];
  for (let m = Math.ceil(span.from / 60) * 60; m < span.to; m += 60) hours.push(m);
  const allDay = event?.allDay
    ? others.filter(
        (e) => e.allDay && e.start.date && day && e.start.date <= day && (e.end.date ?? "") > day,
      )
    : [];

  let caption: string;
  if (!event || (anyOn && events === null)) caption = "";
  else if (!anyOn) caption = "Allow calendar access to see your day here.";
  else if (event.allDay)
    caption = allDay.length
      ? `Also that day: ${allDay.map(eventTitle).join(", ")}`
      : "Nothing else that day.";
  else caption = clashText(clash, tz) ?? "Nothing else at this time.";

  return (
    <div className="invite-mini">
      <div
        className="invite-mini__day"
        aria-label={
          day
            ? `Your day, ${formatDay(day, { weekday: "long", month: "long", day: "numeric" })}`
            : "Your day"
        }
        role="img"
      >
        {timed && (
          <>
            <div className="invite-mini__hours" aria-hidden="true">
              {hours.map((m) => (
                <span key={m} className="invite-mini__hour" style={{ top: at(m) }}>
                  {formatHour(m / 60)}
                </span>
              ))}
            </div>
            <div className="invite-mini__column">
              {hours.map((m) => (
                <span key={m} className="invite-mini__line" style={{ top: at(m) }} />
              ))}
              {blocks
                .filter((b) => b.end > span.from && b.start < span.to)
                .map((b) => {
                  const isInvite = b.event.id === `${event!.id}\ninvite`;
                  const shown = isInvite ? event! : b.event;
                  const { background, text } = eventColors(shown, lookup(shown));
                  const top = Math.max(b.start, span.from);
                  const bottom = Math.min(Math.max(b.end, b.start + MIN_EVENT_MINUTES), span.to);
                  return (
                    <span
                      key={`${b.event.accountId}\n${b.event.calendarId}\n${b.event.id}`}
                      className={cx(
                        "cal-event cal-event--timed invite-mini__event",
                        isInvite && "cal-event--invite invite-mini__event--invite",
                        !isInvite && clash.includes(b.event) && "invite-mini__event--clash",
                        shown.selfResponse === "declined" && "cal-event--declined",
                      )}
                      style={
                        {
                          top: at(top),
                          height: `${((bottom - top) / (span.to - span.from)) * 100}%`,
                          left: `${(b.column / b.columns) * 100}%`,
                          width: `calc(${(b.span / b.columns) * 100}% - var(--space-1))`,
                          "--cal-event-bg": background,
                          "--cal-event-fg": text,
                        } as CSSProperties
                      }
                    >
                      <span className="cal-event__title">{eventTitle(shown)}</span>
                    </span>
                  );
                })}
            </div>
          </>
        )}
        {event?.allDay && (
          <ul className="invite-mini__bars">
            {[event, ...allDay].map((e, i) => {
              const { background, text } = eventColors(e, lookup(e));
              return (
                <li
                  key={i}
                  className={cx("cal-event cal-event--bar", i === 0 && "cal-event--invite")}
                  style={{ "--cal-event-bg": background, "--cal-event-fg": text } as CSSProperties}
                >
                  <span className="cal-event__title">{eventTitle(e)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <p className={cx("invite-mini__caption", clash.length > 0 && "invite-mini__caption--clash")}>
        {caption || <Skeleton width="14em" />}
      </p>
    </div>
  );
}

/**
 * The invite card for `messageId`. `compact` (the email pinned beside the calendar) leaves out the
 * mini day view and Open in Calendar.
 */
export function InviteCard({
  pinned,
  compact = false,
}: {
  pinned: PinnedEmail;
  compact?: boolean;
}) {
  const { accountId, messageId } = pinned;
  const load = useInvite(accountId, messageId);
  const accounts = useCalendarAccounts();
  const tz = displayZone(accounts);
  const invite = load.kind === "ready" ? load.invite : null;
  const event = invite ? shownEvent(invite, accountId) : null;

  // A message whose calendar file holds no event shows no card.
  if (load.kind === "ready" && !invite) return null;

  const notice = invite ? inviteNotice(invite, tz) : null;
  const meeting = invite?.live?.meetUrl ?? invite?.meetingUrl ?? null;
  const location = event?.location ?? null;
  const guests = invite?.live?.attendees.length ? invite.live.attendees : (invite?.attendees ?? []);
  // The calendar's organizer, named as the email names them when the calendar doesn't.
  const liveOrganizer = invite?.live?.organizer ?? null;
  const organizer = liveOrganizer
    ? {
        ...liveOrganizer,
        name:
          liveOrganizer.name ??
          (invite?.organizer?.email?.toLowerCase() === liveOrganizer.email?.toLowerCase()
            ? (invite?.organizer?.name ?? null)
            : null),
      }
    : (invite?.organizer ?? null);
  const day = event ? startDay(event, tz) : null;
  const cancelled = notice?.tone === "danger";

  return (
    <section
      className={cx(
        "invite-card",
        compact && "invite-card--compact",
        cancelled && "invite-card--cancelled",
      )}
      aria-label="Invitation"
    >
      <p className={cx("invite-card__kicker", notice && `invite-card__kicker--${notice.tone}`)}>
        {load.kind === "failed" ? (
          `Couldn't read this invitation: ${load.message}`
        ) : !invite ? (
          <Skeleton width="10em" />
        ) : (
          (notice?.text ??
          (invite.method === "PUBLISH"
            ? "Event"
            : organizer && !organizer.isSelf
              ? `Invitation from ${organizer.name || organizer.email}`
              : "Invitation"))
        )}
      </p>
      <h3 className={cx("invite-card__title", cancelled && "invite-card__title--cancelled")}>
        {event ? eventTitle(event) : <Skeleton width="14em" />}
      </h3>
      <div className="invite-card__row">
        <Clock aria-hidden="true" />
        <span>
          {event ? describeWhen(event, tz) : <Skeleton width="16em" />}
          {event?.recurring || (invite?.recurrence.length ?? 0) > 0 ? (
            <span className="invite-card__muted"> · Repeats</span>
          ) : null}
        </span>
      </div>
      <div className="invite-card__row">
        {meeting ? <Video aria-hidden="true" /> : <MapPin aria-hidden="true" />}
        <span className="invite-card__where">
          {!invite ? (
            <Skeleton width="10em" />
          ) : (
            <>
              {location && <span className="selectable">{location}</span>}
              {meeting && (
                <Button
                  size="sm"
                  variant={location ? "secondary" : "primary"}
                  onClick={() => void openExternal(meeting).catch(() => {})}
                >
                  {joinLabel(meeting)}
                </Button>
              )}
              {!location && !meeting && <span className="invite-card__muted">No place given</span>}
            </>
          )}
        </span>
      </div>
      <div className="invite-card__row">
        <Users aria-hidden="true" />
        <span>{invite ? whoLine(organizer, guests) : <Skeleton width="14em" />}</span>
      </div>
      <AnswerRow invite={invite} accountId={accountId} compact={compact} />
      {!compact && (
        <>
          <MiniDay event={event} />
          <div className="invite-card__footer">
            <Button
              size="sm"
              icon={<CalendarDays />}
              disabled={!event}
              onClick={() => event && openInCalendar(pinned, event)}
            >
              {day
                ? `Open ${formatDay(day, { weekday: "long", month: "short", day: "numeric" })} in Calendar`
                : "Open in Calendar"}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
