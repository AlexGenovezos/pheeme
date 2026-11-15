import { CalendarDays, CalendarPlus, Copy, Mail, UserCheck, UserPlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { revealEvent } from "../calendar/actions";
import { newEventWith } from "../calendar/mailActions";
import { displayZone, useCalendarStore } from "../calendar/calendarStore";
import { formatDay } from "../calendar/dates";
import { Avatar } from "../components/ui/Avatar";
import { Button } from "../components/ui/Button";
import { DetailDialog } from "../components/ui/DetailDialog";
import { Skeleton } from "../components/ui/Skeleton";
import { toast } from "../components/ui/Toast";
import { useComposeStore } from "../compose/composeStore";
import { formatFullDate, formatListDate } from "../lib/dates";
import { type CalendarEvent, type CommandError, openExternal, toCommandError } from "../lib/tauri";
import { openAndMarkRead } from "../mail/actions";
import { threadKey } from "../mail/mailboxes";
import { useSignIn } from "../onboarding/useSignIn";
import { useAccountStore } from "../store/accountStore";
import { personProfile, type PersonProfile, savePersonContact } from "./api";
import { type PersonTarget, usePersonStore } from "./personStore";
import "./person.css";

const profiles = new Map<string, PersonProfile>();
const PEOPLE_API_URL = "https://console.cloud.google.com/apis/library/people.googleapis.com";

/** The person card on screen, if one is open (`personStore`). */
export function PersonHost() {
  const open = usePersonStore((s) => s.open);
  if (!open) return null;
  return (
    <PersonPanel
      key={`${open.accountId}:${open.person.address.toLowerCase()}`}
      accountId={open.accountId}
      person={open.person}
      onClose={() => usePersonStore.getState().close()}
    />
  );
}

/** Who someone is (Google Contacts) and your mail and meetings with them, all read from the account's local cache. */
export function PersonPanel({
  accountId,
  person,
  onClose,
}: {
  accountId: string;
  person: PersonTarget;
  onClose(): void;
}) {
  const account = useAccountStore((s) => s.accounts.find((a) => a.id === accountId));
  const zone = displayZone(useCalendarStore.getState().accounts);
  const key = JSON.stringify([accountId, person.address.toLowerCase(), zone]);
  const [profile, setProfile] = useState<PersonProfile | null>(() => profiles.get(key) ?? null);
  const [error, setError] = useState<CommandError | null>(null);
  const [saveError, setSaveError] = useState<CommandError | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const operation = useRef(false);
  const { state, start, cancel } = useSignIn();
  const connected = state.phase === "connected";
  const shownName = profile?.name ?? person.name ?? person.address;

  useEffect(() => {
    const controller = new AbortController();
    void personProfile(accountId, person.address, zone).then(
      (result) => {
        if (controller.signal.aborted) return;
        if (profiles.size >= 50) profiles.delete(profiles.keys().next().value!);
        profiles.set(key, result);
        setProfile(result);
        setError(null);
      },
      (e) => {
        if (!controller.signal.aborted) setError(toCommandError(e));
      },
    );
    return () => controller.abort();
  }, [accountId, key, person.address, zone, retry, connected]);

  const save = async () => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setSaveError(null);
    try {
      await savePersonContact(
        accountId,
        person.address,
        shownName === person.address ? null : shownName,
      );
      profiles.delete(key);
      setProfile((p) => (p ? { ...p, saved: true } : p));
      toast({ title: "Saved to Google Contacts", description: shownName });
    } catch (e) {
      setSaveError(toCommandError(e));
    } finally {
      operation.current = false;
      setBusy(false);
    }
  };

  const openEvent = async (event: CalendarEvent) => {
    try {
      // Finish the calendar's initial load before revealing an event's day.
      if (!useCalendarStore.getState().accounts) await useCalendarStore.getState().loadAccounts();
      useCalendarStore.getState().setMode("calendar");
      await revealEvent(event);
      onClose();
    } catch (e) {
      setError(toCommandError(e));
    }
  };

  const authorizing = state.phase === "authorizing";
  const allowSaving = saveError?.code === "missing_scope";
  const close = () => {
    if (!operation.current) onClose();
  };

  return (
    <DetailDialog title={shownName} onClose={close}>
      <div className="person-panel__identity">
        <Avatar
          size="lg"
          name={shownName}
          email={person.address}
          src={profile?.photoUrl ?? undefined}
        />
        <div className="person-panel__facts">
          <p className="detail-dialog__note person-panel__address selectable">{person.address}</p>
          <p className="detail-dialog__note selectable">
            {profile ? (
              [profile.organization, profile.phone].filter(Boolean).join(" · ") ||
              (profile.saved ? "In your Google Contacts" : "Not in your Google Contacts")
            ) : error ? (
              "\u00a0"
            ) : (
              <Skeleton width="60%" />
            )}
          </p>
          <p className="detail-dialog__note">{account?.email ?? "\u00a0"}</p>
        </div>
      </div>
      <div className="detail-dialog__actions person-panel__actions">
        <Button
          size="sm"
          icon={<Mail />}
          disabled={busy}
          onClick={() => {
            close();
            useComposeStore.getState().compose(accountId, {
              to: [
                {
                  address: person.address,
                  name: shownName === person.address ? null : shownName,
                },
              ],
            });
          }}
        >
          Email
        </Button>
        <Button
          size="sm"
          icon={<CalendarPlus />}
          disabled={busy}
          onClick={() => {
            close();
            void newEventWith(accountId, {
              address: person.address,
              name: shownName === person.address ? null : shownName,
            });
          }}
        >
          New event
        </Button>
        <Button size="sm" icon={<Copy />} onClick={() => void copyAddress(person.address)}>
          Copy address
        </Button>
        <Button
          size="sm"
          icon={profile?.saved ? <UserCheck /> : <UserPlus />}
          disabled={!profile || profile.saved || busy || authorizing}
          onClick={() => void save()}
        >
          {profile?.saved ? "Saved" : busy ? "Saving…" : "Save contact"}
        </Button>
      </div>
      <div className="detail-dialog__body person-panel__body">
        <section>
          <h3 className="detail-dialog__section-title">Recent conversations</h3>
          <div className="person-panel__list">
            {!profile && !error ? (
              <ProfilePlaceholder />
            ) : profile?.conversations.length ? (
              profile.conversations.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="detail-dialog__row"
                  onClick={() => {
                    useCalendarStore.getState().setMode("mail");
                    openAndMarkRead(threadKey(accountId, t.id), 1, { unread: true });
                    onClose();
                  }}
                >
                  <Mail aria-hidden="true" />
                  <span className="detail-dialog__row-text">
                    <span className="detail-dialog__row-name">{t.subject || "(No subject)"}</span>
                    <span className="detail-dialog__note">{formatListDate(t.date)}</span>
                  </span>
                </button>
              ))
            ) : (
              <p className="detail-dialog__note">
                {error
                  ? "Couldn't read conversations."
                  : "No conversations cached for this address."}
              </p>
            )}
          </div>
        </section>
        <MeetingList
          title="Upcoming meetings · next 90 days"
          events={profile?.events}
          failed={!!error}
          empty={
            profile?.calendarAvailable
              ? "No upcoming meetings on your shown calendars."
              : "Connect this account's calendar to see meetings."
          }
          onOpen={(event) => void openEvent(event)}
        />
        <MeetingList
          title="Past meetings · last 6 months"
          events={profile?.pastEvents}
          failed={!!error}
          empty={
            profile?.calendarAvailable
              ? "No past meetings on your shown calendars."
              : "Connect this account's calendar to see meetings."
          }
          onOpen={(event) => void openEvent(event)}
        />
      </div>
      <p className="detail-dialog__error" role="alert">
        {error?.message ??
          saveError?.message ??
          (state.phase === "failed" ? state.error.message : "")}
      </p>
      <div className="detail-dialog__actions">
        {error && <Button onClick={() => setRetry((n) => n + 1)}>Try again</Button>}
        {allowSaving && (
          <Button
            disabled={authorizing}
            onClick={() => {
              setSaveError(null);
              void start({ kind: "contacts", accountId });
            }}
          >
            {authorizing ? "Finish in your browser…" : "Allow saving contacts"}
          </Button>
        )}
        {authorizing && (
          <Button variant="ghost" onClick={cancel}>
            Cancel sign-in
          </Button>
        )}
        {saveError?.code === "api_disabled" && (
          <Button
            onClick={() =>
              void openExternal(PEOPLE_API_URL).catch((e) => setSaveError(toCommandError(e)))
            }
          >
            Turn on the People API
          </Button>
        )}
      </div>
    </DetailDialog>
  );
}

function copyAddress(address: string) {
  return navigator.clipboard.writeText(address).then(
    () => toast({ title: "Address copied", description: address }),
    () => toast({ title: "Couldn't copy the address", description: address }),
  );
}

function MeetingList({
  title,
  events,
  failed,
  empty,
  onOpen,
}: {
  title: string;
  /** `undefined` until the profile has loaded. */
  events: CalendarEvent[] | undefined;
  failed: boolean;
  empty: string;
  onOpen(event: CalendarEvent): void;
}) {
  return (
    <section>
      <h3 className="detail-dialog__section-title">{title}</h3>
      <div className="person-panel__list">
        {!events && !failed ? (
          <ProfilePlaceholder />
        ) : events?.length ? (
          events.map((event) => (
            <button
              key={`${event.calendarId}:${event.id}`}
              type="button"
              className="detail-dialog__row"
              onClick={() => onOpen(event)}
            >
              <CalendarDays aria-hidden="true" />
              <span className="detail-dialog__row-text">
                <span className="detail-dialog__row-name">{event.summary || "(No title)"}</span>
                <span className="detail-dialog__note">
                  {event.allDay && event.start.date
                    ? formatDay(event.start.date, { month: "short", day: "numeric" })
                    : event.start.ms
                      ? formatFullDate(event.start.ms)
                      : ""}
                </span>
              </span>
            </button>
          ))
        ) : (
          <p className="detail-dialog__note">{failed ? "Couldn't read meetings." : empty}</p>
        )}
      </div>
    </section>
  );
}

function ProfilePlaceholder() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div className="detail-dialog__row" key={i}>
          <Skeleton width="75%" />
        </div>
      ))}
    </>
  );
}
