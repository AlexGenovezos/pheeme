// The event editor's "Check availability" planner: you and each guest as rows of busy time across
// one day's hours (PLANNER_HOURS in the calendar's time zone), the proposed time outlined. Click a
// spot to move the event there (keeping its length), step through days, or find the next time
// everyone whose availability is known is free. Asked of Google live through freeBusy, which
// needs its own consent: until it's allowed, the rows hold an Allow button.
import { ChevronLeft, ChevronRight } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useEffect, useMemo, useState } from "react";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import { Skeleton } from "../components/ui/Skeleton";
import {
  type AvailabilityResult,
  type BusyInterval,
  type CommandError,
  type PersonAvailability,
  calendarAvailability,
  openExternal,
  toCommandError,
} from "../lib/tauri";
import { useSignIn } from "../onboarding/useSignIn";
import { cx } from "../lib/utils";
import {
  isFree,
  knownBusy,
  nextFreeSlot,
  PLANNER_HOURS,
  plannerRange,
  plannerTime,
  roundUpToSlot,
  SEARCH_DAYS,
  SLOT_MINUTES,
  searchRange,
  unknownNote,
  withoutSpan,
} from "./availability";
import { addDays, dateOf, formatDay, formatHour, formatTime, wallClock, zonedMs } from "./dates";
import { type EventForm, moveStart } from "./eventForm";

const HOURS = PLANNER_HOURS.end - PLANNER_HOURS.start;
const SLOT = SLOT_MINUTES * 60_000;
/** Google Cloud's page for turning the Calendar API on. */
const CALENDAR_API_URL =
  "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com";

type Load =
  | { key: string; phase: "loading" }
  | { key: string; phase: "loaded"; result: AvailabilityResult }
  | { key: string; phase: "failed"; error: CommandError };

/** The event's start and end as UTC ms. */
function formSpan(f: EventForm) {
  const startMs = zonedMs(f.startDate, f.startMinutes, f.startZone);
  return { startMs, endMs: zonedMs(f.endDate, f.endMinutes, f.endZone) };
}

/** `form` moved to start at `ms`, keeping its length. */
function movedTo(f: EventForm, ms: number): EventForm {
  const at = wallClock(ms, f.startZone);
  return moveStart(f, at.date, at.minutes);
}

/** Where `[startMs, endMs)` sits across the planner's day, as CSS percentages; null if outside. */
function place(startMs: number, endMs: number, fromMs: number, toMs: number) {
  const s = Math.max(startMs, fromMs);
  const e = Math.min(endMs, toMs);
  if (e <= s) return null;
  const span = toMs - fromMs;
  return { left: `${((s - fromMs) / span) * 100}%`, width: `${((e - s) / span) * 100}%` };
}

export function AvailabilityPlanner({
  form,
  onChange,
  tz,
  selfEmail,
  saved,
}: {
  form: EventForm;
  onChange(form: EventForm): void;
  /** A saved event's time as Google has it, left out of everyone's busy time; null for a new event. */
  saved: BusyInterval | null;
  /** The calendar's time zone, which the planner's hours and "working hours" are in. */
  tz: string;
  /** The account's own address, left out of the guest rows (it is "You"). */
  selfEmail: string | null;
}) {
  const guests = useMemo(
    () => form.guests.filter((g) => g.address.toLowerCase() !== (selfEmail ?? "").toLowerCase()),
    [form.guests, selfEmail],
  );
  const emails = useMemo(() => guests.map((g) => g.address), [guests]);
  const span = formSpan(form);
  const startDay = dateOf(span.startMs, tz);
  const [day, setDay] = useState(startDay);
  const [reload, setReload] = useState(0);
  const [load, setLoad] = useState<Load | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const { state: signIn, start, cancel } = useSignIn();

  // Follow the event to another day (a typed date, a click, "Next available time").
  useEffect(() => setDay(startDay), [startDay]);
  // Allowing access is a sign-in: ask again once it's done.
  useEffect(() => {
    if (signIn.phase === "connected") setReload((n) => n + 1);
  }, [signIn.phase]);

  const range = plannerRange(day, tz);
  const key = `${form.accountId}|${day}|${tz}|${emails.join(",")}|${reload}`;
  useEffect(() => {
    let live = true;
    setLoad({ key, phase: "loading" });
    calendarAvailability(form.accountId, emails, range.fromMs, range.toMs).then(
      (result) => live && setLoad({ key, phase: "loaded", result }),
      (e) => live && setLoad({ key, phase: "failed", error: toCommandError(e) }),
    );
    return () => {
      live = false;
    };
    // `key` names everything the query depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const current = load?.key === key ? load : null;
  const result = current?.phase === "loaded" ? withoutSpan(current.result, saved) : null;
  const error = current?.phase === "failed" ? current.error : null;
  const missingScope = error?.code === "missing_scope";
  const authorizing = signIn.phase === "authorizing";

  const move = (ms: number) => {
    setNote(null);
    onChange(movedTo(form, ms));
  };

  const findNext = async () => {
    setSearching(true);
    setNote(null);
    try {
      const from = roundUpToSlot(Math.max(span.startMs, Date.now()));
      const { fromMs, toMs } = searchRange(from, tz);
      const found = withoutSpan(
        await calendarAvailability(form.accountId, emails, fromMs, toMs),
        saved,
      );
      const slot = nextFreeSlot(knownBusy(found), span.endMs - span.startMs, from, tz);
      const unknown = unknownNote(found, emails);
      if (slot === null) {
        setNote(
          [`No time in the next ${SEARCH_DAYS} days works for everyone.`, unknown]
            .filter(Boolean)
            .join(" "),
        );
        return;
      }
      const when = `${formatDay(dateOf(slot, tz), { weekday: "short", month: "short", day: "numeric" })} at ${formatTime(slot, tz)}`;
      const said = slot === span.startMs ? `Everyone's free ${when}.` : `Moved to ${when}.`;
      onChange(movedTo(form, slot));
      setNote([said, unknown].filter(Boolean).join(" "));
    } catch (e) {
      const err = toCommandError(e);
      if (err.code === "missing_scope") setReload((n) => n + 1);
      setNote(err.message);
    } finally {
      setSearching(false);
    }
  };

  const pick = (e: MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    move(plannerTime((e.clientX - box.left) / box.width, day, tz));
  };

  // The proposed time on this day, and whether a known busy stretch overlaps it.
  const slot = place(span.startMs, span.endMs, range.fromMs, range.toMs);
  const clash = result !== null && !isFree(knownBusy(result), span.startMs, span.endMs);
  const nudge = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    // To the previous or next quarter hour.
    const next =
      e.key === "ArrowLeft"
        ? Math.floor((span.startMs - 1) / SLOT) * SLOT
        : Math.floor(span.startMs / SLOT) * SLOT + SLOT;
    if (next >= range.fromMs && next < range.toMs) move(next);
  };
  const minutesNow = wallClock(span.startMs, tz).minutes;

  const dayLabel = formatDay(day, { weekday: "short", month: "short", day: "numeric" });
  const rows: { id: string; label: string; title: string; person: PersonAvailability | null }[] = [
    { id: "you", label: "You", title: selfEmail ?? "You", person: result?.you ?? null },
    ...guests.map((g, i) => ({
      id: `${i}-${g.address}`,
      label: g.name || g.address,
      title: g.address,
      person: result?.guests.find((p) => p.email.toLowerCase() === g.address.toLowerCase()) ?? null,
    })),
  ];

  return (
    <div className="cal-avail" role="group" aria-label="Guests' availability">
      <div className="cal-avail__bar">
        <IconButton
          size="sm"
          label="Previous day"
          icon={<ChevronLeft />}
          onClick={() => {
            setNote(null);
            setDay((d) => addDays(d, -1));
          }}
        />
        <span className="cal-avail__day" aria-live="polite">
          {dayLabel}
        </span>
        <IconButton
          size="sm"
          label="Next day"
          icon={<ChevronRight />}
          onClick={() => {
            setNote(null);
            setDay((d) => addDays(d, 1));
          }}
        />
        <Button
          size="sm"
          className="cal-avail__next"
          disabled={searching || missingScope}
          onClick={() => void findNext()}
        >
          {searching ? "Finding a time…" : "Next available time"}
        </Button>
      </div>
      <div className="cal-avail__grid">
        <div className="cal-avail__names">
          <span className="cal-avail__corner" aria-hidden="true" />
          {rows.map((r) => (
            <span key={r.id} className="cal-avail__name" title={r.title}>
              {r.label}
            </span>
          ))}
        </div>
        <div className="cal-avail__timeline">
          <div className="cal-avail__hours" aria-hidden="true">
            {Array.from({ length: HOURS / 2 }, (_, i) => PLANNER_HOURS.start + 1 + i * 2).map(
              (h) => (
                <span
                  key={h}
                  className="cal-avail__hour"
                  style={{ left: `${((h - PLANNER_HOURS.start) / HOURS) * 100}%` }}
                >
                  {formatHour(h)}
                </span>
              ),
            )}
          </div>
          {/* Clicking moves the event; the keyboard does it through the proposed time below. */}
          <div className="cal-avail__rows" onClick={pick}>
            {rows.map((r) => (
              <Track
                key={r.id}
                label={r.label}
                person={r.person}
                loading={current === null || current.phase === "loading"}
                failed={error !== null}
                fromMs={range.fromMs}
                toMs={range.toMs}
                tz={tz}
              />
            ))}
            {slot && (
              <div
                className={cx("cal-avail__slot", clash && "cal-avail__slot--clash")}
                style={slot}
                role="slider"
                tabIndex={0}
                aria-label="Proposed time (arrow keys move it by 15 minutes)"
                aria-valuemin={PLANNER_HOURS.start * 60}
                aria-valuemax={PLANNER_HOURS.end * 60}
                aria-valuenow={minutesNow}
                aria-valuetext={`${formatTime(span.startMs, tz)} to ${formatTime(span.endMs, tz)}${clash ? ", someone is busy" : ""}`}
                onKeyDown={nudge}
              />
            )}
          </div>
          {error && (
            <div className="cal-avail__problem" role="alert">
              <span>{error.message}</span>
              {missingScope ? (
                <span className="cal-avail__problem-actions">
                  <Button
                    size="sm"
                    disabled={authorizing}
                    onClick={() => void start({ kind: "availability", accountId: form.accountId })}
                  >
                    {authorizing ? "Finish in your browser…" : "Allow"}
                  </Button>
                  {authorizing && (
                    <Button size="sm" variant="ghost" onClick={cancel}>
                      Cancel
                    </Button>
                  )}
                </span>
              ) : (
                <span className="cal-avail__problem-actions">
                  {error.code === "api_disabled" && (
                    <Button
                      size="sm"
                      onClick={() => void openExternal(CALENDAR_API_URL).catch(() => {})}
                    >
                      Turn on the Calendar API
                    </Button>
                  )}
                  <Button size="sm" onClick={() => setReload((n) => n + 1)}>
                    Try again
                  </Button>
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      <p className="cal-avail__note" role="status">
        {note ??
          (signIn.phase === "failed" ? signIn.error.message : null) ??
          (result ? unknownNote(result, emails) : null) ??
          " "}
      </p>
    </div>
  );
}

/** One person's row: skeleton while loading, busy blocks once loaded, or "not shared". */
function Track({
  label,
  person,
  loading,
  failed,
  fromMs,
  toMs,
  tz,
}: {
  label: string;
  person: PersonAvailability | null;
  loading: boolean;
  failed: boolean;
  fromMs: number;
  toMs: number;
  tz: string;
}) {
  if (loading)
    return (
      <div className="cal-avail__track">
        <Skeleton shape="block" className="cal-avail__skeleton" />
      </div>
    );
  if (failed || !person) return <div className="cal-avail__track" />;
  if (person.status === "unknown")
    return (
      <div
        className="cal-avail__track cal-avail__track--unknown"
        title={person.reason === "notFound" ? undefined : `Google said: ${person.reason}`}
      >
        <span className="cal-avail__unknown">Availability not shared</span>
      </div>
    );
  const blocks = person.busy
    .map((b) => ({ b, at: place(b.startMs, b.endMs, fromMs, toMs) }))
    .filter((x) => x.at !== null);
  const said = blocks.length
    ? `${label}: busy ${blocks.map(({ b }) => `${formatTime(b.startMs, tz)} to ${formatTime(b.endMs, tz)}`).join(", ")}`
    : `${label}: free all day`;
  return (
    <div className="cal-avail__track">
      <span className="cal-avail__sr">{said}</span>
      {blocks.map(({ b, at }) => (
        <span
          key={`${b.startMs}-${b.endMs}`}
          className="cal-avail__busy"
          style={at!}
          title={`Busy ${formatTime(b.startMs, tz)} – ${formatTime(b.endMs, tz)}`}
        />
      ))}
    </div>
  );
}
