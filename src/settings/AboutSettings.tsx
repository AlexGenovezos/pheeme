import { version } from "../../package.json";
import { Button } from "../components/ui/Button";
import { checkForUpdatesNow, displayVersion, useUpdateStore } from "../lib/updater";
import { isTauri } from "../preview/runtime";
import { DiagnosticsSection } from "./DiagnosticsSection";
import { RELEASES } from "./releases";
import { ReleaseNotes } from "./ReleaseNotes";
import { SettingsRow, SettingsSection } from "./rows";

const CHECK_STATUS = {
  idle: null,
  checking: "Checking…",
  current: "Pheeme is up to date.",
  failed: "Couldn't check for updates. Try again later.",
} as const;

export function AboutSettings() {
  const available = useUpdateStore((s) => s.available);
  const applying = useUpdateStore((s) => s.applying);
  const manualCheck = useUpdateStore((s) => s.manualCheck);
  const apply = useUpdateStore((s) => s.apply);
  const desktop = isTauri();

  let description: string;
  let control;
  if (!desktop) description = "Updates are checked by the desktop app.";
  else if (available) description = `Version ${displayVersion(available)} is ready to install.`;
  else description = CHECK_STATUS[manualCheck] ?? "Pheeme checks for updates in the background.";

  if (desktop && available)
    control = (
      <Button variant="primary" size="sm" disabled={applying} onClick={() => void apply()}>
        {applying ? "Installing…" : "Restart to update"}
      </Button>
    );
  else if (desktop)
    control = (
      <Button
        size="sm"
        disabled={manualCheck === "checking"}
        onClick={() => void checkForUpdatesNow()}
      >
        Check for updates
      </Button>
    );

  return (
    <>
      <SettingsSection title="Pheeme">
        <SettingsRow
          title="Version"
          description="Open-source Gmail client, MIT licensed."
          control={<span className="settings-about__version">{displayVersion(version)}</span>}
        />
        <SettingsRow title="Updates" description={description} control={control} />
      </SettingsSection>
      {/* Above the release notes, so "Taking too long? Send diagnostics" lands on it without scrolling. */}
      <DiagnosticsSection />
      {RELEASES.length > 0 && (
        <SettingsSection title="What's new">
          <ReleaseNotes releases={RELEASES} current={version} />
        </SettingsSection>
      )}
    </>
  );
}
