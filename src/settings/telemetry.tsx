import { useEffect, useState } from "react";
import { Switch } from "../components/ui/Switch";
import { setTelemetry, telemetryEnabled } from "../lib/tauri";

export const TELEMETRY_TITLE = "Share anonymous usage stats";
export const TELEMETRY_DESCRIPTION =
  "Once a day, Pheeme sends a random ID, its version, your operating system and chip type, so the developer knows how many people use it and on what computers. It never includes your email address, your accounts or anything in your mail.";

/**
 * The anonymous usage ping switch, shared by Settings › Diagnostics and the welcome screen. Shows on (the
 * default) while loading; disabled until the stored choice is known.
 */
export function TelemetrySwitch() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    telemetryEnabled()
      .then((value) => live && setEnabled(typeof value === "boolean" ? value : null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  async function change(next: boolean) {
    setBusy(true);
    setEnabled(next);
    try {
      setEnabled(await setTelemetry(next));
    } catch {
      setEnabled(!next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Switch
      label={TELEMETRY_TITLE}
      checked={enabled ?? true}
      disabled={enabled === null || busy}
      onChange={(next) => void change(next)}
    />
  );
}
