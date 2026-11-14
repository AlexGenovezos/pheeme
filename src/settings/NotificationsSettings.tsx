import { useEffect, useState } from "react";
import { Button } from "../components/ui/Button";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { Select } from "../components/ui/Select";
import { Skeleton } from "../components/ui/Skeleton";
import { Switch } from "../components/ui/Switch";
import {
  getDesktopSettings,
  setAccountNotifications,
  setCalendarReminders,
  setNotificationSchedule,
  setTrayIcon,
  type DesktopSettings,
  type NotifySchedule,
} from "../desktop/api";
import { resetNotificationPrompt } from "../desktop/prompt";
import { toCommandError } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { SettingsRow, SettingsSection } from "./rows";

type Mode = NotifySchedule["mode"];
const MODES = [
  { value: "always", label: "Any time" },
  { value: "workHours", label: "Work hours" },
  { value: "off", label: "Off" },
] as const satisfies readonly { value: Mode; label: string }[];
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => ({
  value: hour,
  label: `${String(hour).padStart(2, "0")}:00`,
}));

function HourSelect({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  disabled: boolean;
  onChange(hour: number): void;
}) {
  return (
    <Select
      className="settings-select settings-select--time"
      aria-label={label}
      value={value}
      disabled={disabled}
      options={HOUR_OPTIONS}
      onChange={onChange}
    />
  );
}

export function NotificationsSettings() {
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const knownAccounts = useAccountStore((s) => s.accounts);
  const accountsLoaded = useAccountStore((s) => s.loaded);
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

  const schedule = settings?.schedule;
  const saveSchedule = (patch: Partial<NotifySchedule>) => {
    if (schedule) void change(() => setNotificationSchedule({ ...schedule, ...patch }));
  };

  // The account list is already known when Settings opens, so its rows are there from the first
  // frame; each switch is a skeleton until the saved choices arrive.
  const accountRows: Array<{ accountId: string; email: string; enabled: boolean | null }> = settings
    ? settings.accounts
    : knownAccounts.map((a) => ({ accountId: a.id, email: a.email, enabled: null }));

  return (
    <>
      <SettingsSection title="Schedule">
        <SettingsRow
          title="When to alert"
          description="Outside these hours new mail and event reminders arrive quietly. Your system's Focus / Do Not Disturb still applies."
          control={
            <SegmentedControl
              label="When to alert"
              // Before the settings load nothing is chosen (no segment matches), so no wrong mode shows.
              value={schedule?.mode as Mode}
              options={MODES}
              disabled={busy || !schedule}
              onChange={(mode) => saveSchedule({ mode })}
            />
          }
        />
        {schedule?.mode === "workHours" && (
          <>
            <SettingsRow
              title="From"
              control={
                <HourSelect
                  label="From"
                  value={schedule.startHour}
                  disabled={busy}
                  onChange={(startHour) => saveSchedule({ startHour })}
                />
              }
            />
            <SettingsRow
              title="Until"
              control={
                <HourSelect
                  label="Until"
                  value={schedule.endHour}
                  disabled={busy}
                  onChange={(endHour) => saveSchedule({ endHour })}
                />
              }
            />
            <SettingsRow
              title="Weekdays only"
              control={
                <Switch
                  label="Weekdays only"
                  checked={schedule.weekdaysOnly}
                  disabled={busy}
                  onChange={(weekdaysOnly) => saveSchedule({ weekdaysOnly })}
                />
              }
            />
          </>
        )}
      </SettingsSection>
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
        {accountRows.map((account) => (
          <SettingsRow
            key={account.accountId}
            title={account.email}
            description="Notify for new unread Primary mail"
            control={
              account.enabled === null ? (
                <Skeleton shape="block" className="settings-switch-pending" />
              ) : (
                <Switch
                  label={`Notifications for ${account.email}`}
                  checked={account.enabled}
                  disabled={busy}
                  onChange={(enabled) =>
                    void change(() => setAccountNotifications(account.accountId, enabled))
                  }
                />
              )
            }
          />
        ))}
        {accountRows.length === 0 && (settings || accountsLoaded) && (
          <SettingsRow title="Connect an account to enable notifications" />
        )}
      </SettingsSection>
      <SettingsSection title="Calendar">
        <SettingsRow
          title="Event reminders"
          description="Get an alert at each event's notification reminders (its own, or its calendar's default), for every calendar you show. Click it to open the event. Declined events stay silent, and email reminders still come from Google."
          control={
            <Switch
              label="Event reminders"
              checked={settings?.calendarReminders ?? true}
              disabled={busy || !settings}
              onChange={(enabled) => void change(() => setCalendarReminders(enabled))}
            />
          }
        />
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
            !settings ? (
              <Skeleton width="24em" />
            ) : settings.trayAvailable ? (
              "Pheeme keeps running when you close its window"
            ) : (
              "Closing the window quits Pheeme"
            )
          }
          description={
            !settings ? (
              <Skeleton width="32em" />
            ) : settings.trayAvailable ? (
              "Choose Quit Pheeme from the icon's menu to stop sync and notifications."
            ) : settings.trayEnabled ? (
              "Keep Pheeme open for sync and notifications. On Linux, the icon needs a desktop with an AppIndicator / StatusNotifier host."
            ) : (
              "Keep Pheeme open for sync and notifications, or show the icon to keep it running in the background."
            )
          }
        />
      </SettingsSection>
      {error && <p role="alert">{error}</p>}
      {error && !settings && <Button onClick={() => void load()}>Try again</Button>}
    </>
  );
}
