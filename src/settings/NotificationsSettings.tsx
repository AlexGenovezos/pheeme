import { useEffect, useState } from "react";
import { Button } from "../components/ui/Button";
import { Switch } from "../components/ui/Switch";
import {
  getDesktopSettings,
  setAccountNotifications,
  setTrayIcon,
  type DesktopSettings,
} from "../desktop/api";
import { resetNotificationPrompt } from "../desktop/prompt";
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

  async function change(update: () => Promise<DesktopSettings>) {
    setBusy(true);
    setError(null);
    let next: DesktopSettings | null = null;
    try {
      next = await update();
    } catch (raw) {
      setError(toCommandError(raw).message);
      // A refused change can still be saved as answered (blocked permission records "off").
      next = await getDesktopSettings().catch(() => null);
    } finally {
      setBusy(false);
    }
    if (!next) return;
    setSettings(next);
    // Answering here makes a visible first-run prompt moot.
    if (next.accounts.every((a) => a.asked)) resetNotificationPrompt();
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
                onChange={(enabled) =>
                  void change(() => setAccountNotifications(account.accountId, enabled))
                }
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
          title="Show icon in the menu bar or notification area"
          description="Shows your unread inbox count, with a menu to open or quit Pheeme. While the icon is shown, closing the window keeps Pheeme running so sync and notifications continue."
          control={
            <Switch
              label="Show icon in the menu bar or notification area"
              checked={settings?.trayEnabled ?? false}
              disabled={busy || !settings}
              onChange={(shown) => void change(() => setTrayIcon(shown))}
            />
          }
        />
        <SettingsRow
          title={
            settings?.trayAvailable
              ? "Pheeme keeps running when you close its window"
              : "Closing the window quits Pheeme"
          }
          description={
            settings?.trayAvailable
              ? "Choose Quit Pheeme from the icon's menu to stop sync and notifications."
              : settings?.trayEnabled
                ? "Keep Pheeme open for sync and notifications. On Linux, the icon needs a desktop with an AppIndicator / StatusNotifier host."
                : "Keep Pheeme open for sync and notifications, or show the icon to keep it running in the background."
          }
        />
      </SettingsSection>
      {error && <p role="alert">{error}</p>}
      {error && !settings && <Button onClick={() => void load()}>Try again</Button>}
    </>
  );
}
