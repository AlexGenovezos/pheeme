// The Add to calendar dialog (an email's `.ics` file, or the invite card's Add to calendar): every
// event in the file, ticked, the calendar they go on, and Add. An invitation you're a guest of is
// accepted instead, on your own calendar; events already on a calendar offer Open in Calendar.
// It opens once the file is read (`openAddFromFile`), so nothing in it moves when data arrives.
import { type FormEvent, useId, useMemo, useState } from "react";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { toast } from "../components/ui/Toast";
import {
  addCalendarFileEvents,
  type CalendarFile,
  type FileEvent,
  respondToCalendarInvite,
  toCommandError,
} from "../lib/tauri";
import { cx } from "../lib/utils";
import { AllowButton, needsAllow } from "./AccessControls";
import { writableCalendars } from "./actions";
import {
  type AddPlan,
  asEvent,
  calendarName,
  defaultCalendar,
  type FileSource,
  planFor,
  useAddFromFileStore,
} from "./addFromFile";
import { displayZone, useCalendarStore } from "./calendarStore";
import { CalendarPicker } from "./EventFields";
import { describeWhen } from "./EventPopover";
import { openInCalendar } from "./mailActions";
import "../components/ui/Surface.css";
import "./editing.css";
import "./addFromFile.css";

export function AddFromFileHost() {
  const open = useAddFromFileStore((s) => s.open);
  return open ? (
    <AddFromFileDialog key={`${open.source.messageId}\n${open.source.attachmentId}`} {...open} />
  ) : null;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function AddFromFileDialog({ source, file }: { source: FileSource; file: CalendarFile }) {
  const titleId = useId();
  const close = useAddFromFileStore((s) => s.close);
  const accounts = useCalendarStore((s) => s.accounts);
  const tz = displayZone(accounts);
  const plan: AddPlan = useMemo(() => planFor(file), [file]);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    () => new Set(plan.kind === "copy" ? plan.events.map((e) => e.uid) : []),
  );
  const first = defaultCalendar(accounts, source.accountId);
  const [picked, setTarget] = useState<{ accountId: string; calendarId: string } | null>(null);
  // Until one is picked: the default, which appears once calendar access is allowed here.
  const target =
    picked ??
    (first ? { accountId: first.account.accountId, calendarId: first.calendar.id } : null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const writable = writableCalendars(accounts);
  const nameOf = (accountId: string, calendarId: string) => {
    const w = writable.find(
      (c) => c.account.accountId === accountId && c.calendar.id === calendarId,
    );
    if (w) return calendarName(w);
    const account = accounts?.find((a) => a.accountId === accountId);
    return account?.calendars.find((c) => c.id === calendarId)?.summary ?? account?.email ?? null;
  };
  const receiving = accounts?.find((a) => a.accountId === source.accountId);
  const toAdd = plan.kind === "copy" ? plan.events.filter((e) => chosen.has(e.uid)) : [];
  const several = file.events.length > 1;

  const show = (e: FileEvent) => {
    close();
    openInCalendar(source, asEvent(e, source.accountId));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    if (plan.kind === "there") return show(plan.event);
    if (plan.kind === "none") return close();
    setSaving(true);
    setError(null);
    try {
      if (plan.kind === "accept") {
        await respondToCalendarInvite(
          source.accountId,
          plan.event.uid,
          "accepted",
          null,
          plan.event.import,
        );
        close();
        const event = plan.event;
        toast({
          title: `Added “${event.summary || "Event"}” and accepted`,
          description: "The organizer has been told you're going.",
          action: {
            label: "Open in Calendar",
            run: () => openInCalendar(source, asEvent(event, source.accountId)),
          },
        });
      } else if (target) {
        const added = await addCalendarFileEvents(
          source,
          target.accountId,
          target.calendarId,
          toAdd.map((x) => x.uid),
        );
        close();
        const firstEvent = toAdd[0];
        const fresh = added.events.length - added.already;
        toast({
          title:
            fresh === 1 && toAdd.length === 1
              ? `Added “${firstEvent.summary || "Event"}” to ${nameOf(target.accountId, target.calendarId)}`
              : `Added ${plural(fresh, "event")} to ${nameOf(target.accountId, target.calendarId)}`,
          description:
            added.already > 0 ? `${plural(added.already, "event")} were already there.` : undefined,
          action: {
            label: "Open in Calendar",
            run: () =>
              openInCalendar(source, {
                ...asEvent(firstEvent, target.accountId),
                ...added.events[0],
              }),
          },
        });
      }
    } catch (err) {
      setError(toCommandError(err).message);
    } finally {
      setSaving(false);
    }
  };

  let message: string;
  let primary: string;
  if (plan.kind === "accept") {
    message = "You're invited. Adding it accepts the invitation, and the organizer is told.";
    primary = "Add and accept";
  } else if (plan.kind === "there") {
    message = several
      ? "These events are already on your calendar."
      : "This event is already on your calendar.";
    primary = "Open in Calendar";
  } else if (plan.kind === "none") {
    message = several ? "These events were cancelled." : "This event was cancelled.";
    primary = "Close";
  } else {
    message = several
      ? `${plural(file.events.length, "event")} in this file. Copies go on your calendar; nobody is emailed.`
      : "A copy goes on your calendar; nobody is emailed.";
    primary = toAdd.length > 1 ? `Add ${toAdd.length} events` : "Add";
  }
  const noCalendar = plan.kind === "copy" && !target;
  const disabled = saving || (plan.kind === "copy" && (toAdd.length === 0 || !target));

  return (
    <Modal
      title="Add to Google Calendar"
      titleId={titleId}
      onClose={close}
      scrimClassName="cal-dialog-scrim dialog-scrim"
      className="cal-prompt cal-file dialog-surface"
      titleClassName="cal-prompt__title"
    >
      <form className="cal-prompt__form" onSubmit={(e) => void submit(e)}>
        <p className="cal-prompt__message">{message}</p>
        <ul className="cal-file__events" aria-label="Events">
          {file.events.map((e) => {
            const pickable = plan.kind === "copy" && !e.cancelled && !e.existing;
            const status = e.cancelled
              ? "Cancelled"
              : e.existing
                ? `On ${nameOf(e.existing.accountId, e.existing.calendarId) ?? "your calendar"}`
                : e.repeats
                  ? "Repeats"
                  : null;
            const text = (
              <span className="cal-file__text">
                <span className="cal-file__title">{e.summary || "(No title)"}</span>
                <span className="cal-file__when">
                  {describeWhen(asEvent(e, source.accountId), tz)}
                  {e.location ? ` · ${e.location}` : ""}
                </span>
              </span>
            );
            return (
              <li
                key={e.uid}
                className={cx(
                  "cal-file__event",
                  !pickable && plan.kind === "copy" && "cal-file__event--done",
                )}
              >
                {plan.kind === "copy" && several ? (
                  <label className="cal-check cal-file__pick">
                    <input
                      type="checkbox"
                      checked={pickable && chosen.has(e.uid)}
                      disabled={!pickable || saving}
                      aria-label={e.summary || "Event"}
                      onChange={(ev) => {
                        const next = new Set(chosen);
                        if (ev.currentTarget.checked) next.add(e.uid);
                        else next.delete(e.uid);
                        setChosen(next);
                      }}
                    />
                    {text}
                  </label>
                ) : (
                  text
                )}
                {status && <span className="cal-file__status">{status}</span>}
              </li>
            );
          })}
        </ul>
        <div className="cal-file__calendar">
          <div className="cal-file__calendar-row">
            <span>Calendar</span>
            {plan.kind === "copy" && target ? (
              <CalendarPicker
                accountId={target.accountId}
                calendarId={target.calendarId}
                disabled={saving}
                onChange={(accountId, calendarId) => setTarget({ accountId, calendarId })}
              />
            ) : plan.kind === "copy" ? (
              receiving && needsAllow(receiving) ? (
                <AllowButton account={receiving} />
              ) : null
            ) : (
              <span className="cal-file__hint">
                {plan.kind === "there"
                  ? (nameOf(plan.event.existing!.accountId, plan.event.existing!.calendarId) ??
                    "Your calendar")
                  : (receiving?.email ?? "Your calendar")}
              </span>
            )}
          </div>
          <p className="cal-file__hint">
            {noCalendar
              ? "Allow calendar access to add events here."
              : plan.kind === "accept"
                ? "An invitation goes on the calendar of the account it was sent to."
                : " "}
          </p>
        </div>
        {/* Always there, so the dialog doesn't grow when Google refuses. */}
        <p className="cal-file__error" role="alert">
          {error ?? " "}
        </p>
        <div className="cal-prompt__actions">
          {plan.kind !== "none" && (
            <Button size="sm" variant="ghost" onClick={close}>
              Cancel
            </Button>
          )}
          <Button size="sm" variant="primary" type="submit" disabled={disabled} data-autofocus="">
            {primary}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
