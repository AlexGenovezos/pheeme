// Settings › Contacts: compose suggests people from each account's mail, and from its Google Contacts once the
// account allows it. That takes two things in the user's own Google Cloud setup: the People API turned on, and a
// sign-in that ticked the contacts boxes. This page walks through whichever is missing.
import { useCallback, useEffect, useState } from "react";
import { Button } from "../components/ui/Button";
import { formatListDate } from "../lib/dates";
import {
  type GoogleContactsStatus,
  googleContactsStatus,
  openExternal,
  refreshGoogleContacts,
  toCommandError,
} from "../lib/tauri";
import { ReconnectButton } from "../onboarding/Reconnect";
import { useAccountStore } from "../store/accountStore";
import { SettingsRow, SettingsSection } from "./rows";

export const PEOPLE_API_URL = "https://console.cloud.google.com/apis/library/people.googleapis.com";

type State =
  | { kind: "loading" }
  | { kind: "ready"; status: GoogleContactsStatus }
  | { kind: "failed"; message: string };

function AccountContacts({ accountId, email }: { accountId: string; email: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [checking, setChecking] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setState({ kind: "ready", status: await refreshGoogleContacts(accountId) });
    } catch (e) {
      setState({ kind: "failed", message: toCommandError(e).message });
    } finally {
      setChecking(false);
    }
  }, [accountId]);

  useEffect(() => {
    let live = true;
    googleContactsStatus(accountId).then(
      (status) => {
        if (!live) return;
        setState({ kind: "ready", status });
        // Never checked yet (a new account, or the first download hasn't run): find out now.
        if (status.status === "unknown") void check();
      },
      (e: unknown) => live && setState({ kind: "failed", message: toCommandError(e).message }),
    );
    return () => {
      live = false;
    };
  }, [accountId, check]);

  const checkAgain = (
    <Button size="sm" disabled={checking} onClick={() => void check()}>
      {checking ? "Checking…" : "Check again"}
    </Button>
  );

  const enableRow = (url: string) => (
    <SettingsRow
      title="1. Turn on the People API"
      description="Opens the People API in your Google Cloud project. Check the project is the one you made for Pheeme, then click Enable."
      control={
        <Button size="sm" onClick={() => void openExternal(url).catch(() => {})}>
          Open People API
        </Button>
      }
    />
  );

  const statusRows = (status: GoogleContactsStatus) => {
    switch (status.status) {
      case "unknown":
        return <SettingsRow title="Checking Google Contacts…" />;
      case "on":
        return (
          <SettingsRow
            title="Google Contacts"
            description={`On: ${status.count.toLocaleString()} ${status.count === 1 ? "address" : "addresses"}${
              status.syncedAt ? `, updated ${formatListDate(status.syncedAt)}` : ""
            }. Updated every few hours.`}
            control={
              <Button size="sm" disabled={checking} onClick={() => void check()}>
                {checking ? "Updating…" : "Update now"}
              </Button>
            }
          />
        );
      case "missing_scope":
        return (
          <>
            <SettingsRow
              title="Suggest people from your Google Contacts"
              description="Two steps. If you already turned the People API on, skip to the second."
            />
            {enableRow(PEOPLE_API_URL)}
            <SettingsRow
              title="2. Sign in again"
              description="On Google's screen, tick the boxes to see your contacts. Your mail stays as it is."
              control={<ReconnectButton accountId={accountId} />}
            />
          </>
        );
      case "api_disabled":
        return (
          <>
            <SettingsRow
              title="Suggest people from your Google Contacts"
              description="The People API is off in your Google Cloud project."
            />
            {enableRow(status.enableUrl ?? PEOPLE_API_URL)}
            <SettingsRow
              title="2. Check again"
              description="Google can take a minute to turn it on."
              control={checkAgain}
            />
          </>
        );
      case "error":
        return (
          <SettingsRow
            title="Couldn't download Google Contacts"
            description={status.message ?? undefined}
            control={checkAgain}
          />
        );
    }
  };

  return (
    <SettingsSection title={email}>
      {state.kind === "loading" && <SettingsRow title="Checking Google Contacts…" />}
      {state.kind === "failed" && (
        <SettingsRow
          title="Couldn't check Google Contacts"
          description={state.message}
          control={checkAgain}
        />
      )}
      {state.kind === "ready" && statusRows(state.status)}
    </SettingsSection>
  );
}

export function ContactsSettings() {
  const accounts = useAccountStore((s) => s.accounts);
  return (
    <>
      <p className="settings-empty">
        When you type in To, Cc or Bcc, Pheeme suggests people you've emailed or heard from. With
        Google Contacts on, it suggests the people saved there too. Suggestions come from this
        computer, so they appear as you type.
      </p>
      {accounts.length === 0 ? (
        <p className="settings-empty">No accounts connected.</p>
      ) : (
        accounts.map((a) => <AccountContacts key={a.id} accountId={a.id} email={a.email} />)
      )}
    </>
  );
}
