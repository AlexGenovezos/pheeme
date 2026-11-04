import { useEffect, useState } from "react";
import { Button } from "../components/ui/Button";
import { Switch } from "../components/ui/Switch";
import { getDesktopSettings, setAccountNotifications, type DesktopSettings } from "../desktop/api";
import { toCommandError } from "../lib/tauri";
import { SettingsRow, SettingsSection } from "./rows";

export function NotificationsSettings() {
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setError(null);
    try {
      setSettings(await getDesktopSettings());
    } catch (raw) {
      setError(toCommandError(raw).message);
    }
  };
  useEffect(() => {
    let stopped = false;
    getDesktopSettings().then(
      (value) => {
        if (!stopped) setSettings(value);
      },
      (raw) => {
        if (!stopped) setError(toCommandError(raw).message);
      },
    );
    return () => {
      stopped = true;
    };
  }, []);

  async function toggle(accountId: string, enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      setSettings(await setAccountNotifications(accountId, enabled));
    } catch (raw) {
      setError(toCommandError(raw).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SettingsSection title="Desktop notifications">
        <SettingsRow
          title="New Primary mail"
          description="Get an alert with the sender, subject and preview for newly delivered unread Primary mail. Click it to open the conversation. Initial downloads and older mail stay silent."
        />
        {settings?.permission === "denied" && (
          <SettingsRow
            title="Notifications are blocked"
            description="Allow Pheeme in your system notification settings, then enable notifications for an account."
          />
        )}
        <SettingsRow
          title="System preferences"
          description="Your system controls banners, sounds, lock-screen previews and Focus / Do Not Disturb. Enabling an account may ask for notification permission."
        />
        {settings?.accounts.map((account) => (
          <SettingsRow
            key={account.accountId}
            title={account.email}
            description="Notify for new unread Primary mail"
            control={
              <Switch
                label={`Notifications for ${account.email}`}
                checked={account.enabled}
                disabled={busy}
                onChange={(enabled) => void toggle(account.accountId, enabled)}
              />
            }
          />
        ))}
        {settings?.accounts.length === 0 && (
          <SettingsRow title="Connect an account to enable notifications" />
        )}
        {!settings && !error && <SettingsRow title="Loading notification settings…" />}
      </SettingsSection>
      <SettingsSection title="Tray and background sync">
        <SettingsRow
          title={
            settings?.trayAvailable
              ? "Pheeme keeps running when you close its window"
              : "Background access"
          }
          description={
            settings?.trayAvailable
              ? "The menu bar or tray shows your unread inbox count. Use its menu to open Pheeme, mark an account's mail read or quit. Quitting stops sync and notifications."
              : "Keep Pheeme open for sync and notifications. On Linux, tray support requires a desktop with an AppIndicator / StatusNotifier host."
          }
        />
      </SettingsSection>
      {error && <p role="alert">{error}</p>}
      {error && !settings && <Button onClick={() => void load()}>Try again</Button>}
    </>
  );
}
