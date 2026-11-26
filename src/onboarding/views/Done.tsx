import { Bell } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { getDesktopSettings, setAccountNotifications } from "../../desktop/api";
import { resetNotificationPrompt } from "../../desktop/prompt";
import { type AccountInfo, toCommandError } from "../../lib/tauri";

/**
 * The last step: the account is in, and Pheeme asks once whether to alert on its new mail.
 * An account already answered for (signing in again, Settings) just continues.
 */
export function Done({ account, onContinue }: { account: AccountInfo; onContinue: () => void }) {
  // null until the settings are read; "ask" until answered here.
  const [alerts, setAlerts] = useState<null | "ask" | "on" | "off">(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    getDesktopSettings()
      .then((settings) => {
        const entry = settings.accounts.find((a) => a.accountId === account.id);
        return !entry ? "off" : entry.asked ? (entry.enabled ? "on" : "off") : "ask";
      })
      // Settings that can't be read (or a malformed reply) leave the sidebar's offer to ask later.
      .catch(() => "off" as const)
      .then((next) => {
        if (!stopped) setAlerts(next);
      });
    return () => {
      stopped = true;
    };
  }, [account.id]);

  async function answer(enabled: boolean) {
    setBusy(true);
    try {
      const next = await setAccountNotifications(account.id, enabled);
      if (next.accounts.every((a) => a.asked)) resetNotificationPrompt();
      onContinue();
    } catch (raw) {
      // Blocked by the system: Pheeme saved the answer as off, so there's nothing left to ask.
      setBlocked(toCommandError(raw).message);
      setAlerts("off");
      setBusy(false);
      const next = await getDesktopSettings().catch(() => null);
      if (next?.accounts.every((a) => a.asked)) resetNotificationPrompt();
    }
  }

  const asking = alerts === null || alerts === "ask";
  return (
    <>
      <div className="done-mark" aria-hidden>
        ✓
      </div>
      <h1>{account.email} is connected</h1>
      <p className="guide-lead">
        Pheeme can now reach this account. You can add more accounts at any time.
      </p>
      <section className="done-alerts" aria-labelledby="done-alerts-title">
        <Bell aria-hidden="true" />
        <div>
          <h2 id="done-alerts-title" className="done-alerts__title">
            New mail alerts
          </h2>
          <p className="done-alerts__description">
            {asking
              ? `Get an alert with the sender, subject and preview when new Primary mail arrives for ${account.email}.`
              : `Alerts are ${alerts} for this account. Change them any time in Settings › Notifications.`}
          </p>
          {blocked && <p role="alert">{blocked}</p>}
        </div>
      </section>
      <div className="onboarding-footer">
        {asking ? (
          <Button
            variant="ghost"
            size="lg"
            disabled={alerts === null || busy}
            onClick={() => void answer(false)}
          >
            Not now
          </Button>
        ) : (
          <span />
        )}
        {asking ? (
          <Button
            variant="primary"
            size="lg"
            disabled={alerts === null || busy}
            onClick={() => void answer(true)}
          >
            Turn on alerts
          </Button>
        ) : (
          <Button variant="primary" size="lg" onClick={onContinue}>
            Continue
          </Button>
        )}
      </div>
    </>
  );
}
