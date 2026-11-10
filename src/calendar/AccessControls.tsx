// Getting an account's calendar going: allow access (an incremental Google sign-in), turn the
// Calendar API on in the user's own Google Cloud project, or retry after an error.
import { Button } from "../components/ui/Button";
import { formatListDate } from "../lib/dates";
import { type CalendarAccount, calendarSyncNow, openExternal, toCommandError } from "../lib/tauri";
import { useSignIn } from "../onboarding/useSignIn";
import { useEffect, useState } from "react";
import { useCalendarStore } from "./calendarStore";

export const CALENDAR_API_URL =
  "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com";
export const TASKS_API_URL = "https://console.cloud.google.com/apis/library/tasks.googleapis.com";

/** The account hasn't allowed calendar access yet (or Google no longer has it). */
export const needsAllow = (a: CalendarAccount) =>
  a.access.status === "unknown" || a.access.status === "missing_scope";

/** **Allow calendar access**: Google's consent screen in the browser, for this account only. */
export function AllowButton({
  account,
  size = "sm",
}: {
  account: Pick<CalendarAccount, "accountId">;
  size?: "sm" | "md";
}) {
  const { state, start, cancel } = useSignIn();
  const connected = state.phase === "connected";
  useEffect(() => {
    if (connected) void useCalendarStore.getState().loadAccounts();
  }, [connected]);
  // Allowed: the first sync runs now, and the sidebar fills in when it reports back.
  if (connected)
    return (
      <span className="cal-access__waiting" role="status">
        Downloading your calendars…
      </span>
    );
  if (state.phase === "authorizing")
    return (
      <span className="cal-access__waiting" role="status">
        Finish in your browser…{" "}
        <Button size="sm" variant="ghost" onClick={cancel}>
          Cancel
        </Button>
      </span>
    );
  return (
    <span className="cal-access__allow">
      <Button
        size={size}
        variant="primary"
        onClick={() => void start({ kind: "calendar", accountId: account.accountId })}
      >
        Allow calendar access
      </Button>
      {state.phase === "failed" && (
        <span className="cal-access__error" role="alert">
          {state.error.message}
        </span>
      )}
    </span>
  );
}

/** "Check again" after turning the API on, or "Try again" after an error. */
export function CheckAgainButton({ account, label }: { account: CalendarAccount; label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      await calendarSyncNow(account.accountId);
    } catch (e) {
      setError(toCommandError(e).message);
    } finally {
      setBusy(false);
      void useCalendarStore.getState().loadAccounts();
    }
  };
  return (
    <span className="cal-access__allow">
      <Button size="sm" disabled={busy} onClick={() => void check()}>
        {busy ? "Checking…" : label}
      </Button>
      {error && (
        <span className="cal-access__error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

export const openApiPage = (url: string) => void openExternal(url).catch(() => {});

/** One line on how the account's calendar sync is going. */
export function syncLine(account: CalendarAccount): string {
  const { access } = account;
  switch (access.status) {
    case "on":
      return access.syncedAt ? `Updated ${formatListDate(access.syncedAt)}` : "Downloading…";
    case "api_disabled":
      return "The Google Calendar API is off in your Google Cloud project.";
    case "error":
      return `Couldn't update: ${access.message ?? "unknown error"}`;
    default:
      return "Calendar access not allowed yet.";
  }
}

/** What an account not yet showing its calendars needs, as a compact block (sidebar). */
export function AccountAccess({ account }: { account: CalendarAccount }) {
  if (needsAllow(account)) return <AllowButton account={account} />;
  if (account.access.status === "api_disabled")
    return (
      <span className="cal-access__allow">
        <Button size="sm" onClick={() => openApiPage(account.access.enableUrl ?? CALENDAR_API_URL)}>
          Turn on the Calendar API
        </Button>
        <CheckAgainButton account={account} label="Check again" />
      </span>
    );
  if (account.access.status === "error")
    return <CheckAgainButton account={account} label="Try again" />;
  return null;
}
