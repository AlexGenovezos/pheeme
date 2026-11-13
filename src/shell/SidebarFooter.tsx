// The sidebar's footer, the same in Mail and Calendar: the Mail | Calendar switch across the top
// row; below it Settings, Stats and Add account on the left, Check for updates on the right.
import { BarChart3, CircleArrowUp, Settings, UserPlus } from "lucide-react";
import { ModeSwitch } from "../calendar/ModeSwitch";
import { IconButton } from "../components/ui/IconButton";
import { toast } from "../components/ui/Toast";
import { useKeybinding } from "../keyboard/useCommands";
import { checkForUpdatesNow, displayVersion, useUpdateStore } from "../lib/updater";
import { isTauri } from "../preview/runtime";
import { useSettingsStore } from "../settings/settingsStore";
import { useStatsStore } from "../stats/statsStore";

export function SidebarFooter({ onAddAccount }: { onAddAccount?: () => void }) {
  const settingsShortcut = useKeybinding("settings.open");
  const statsShortcut = useKeybinding("stats.open");
  return (
    <div className="sidebar__footer">
      <ModeSwitch />
      <div className="sidebar__footer-row">
        <IconButton
          label="Settings"
          shortcut={settingsShortcut}
          icon={<Settings />}
          onClick={() => useSettingsStore.getState().openSettings()}
        />
        <IconButton
          label="Mail stats"
          shortcut={statsShortcut}
          icon={<BarChart3 />}
          onClick={() => useStatsStore.getState().openStats()}
        />
        {onAddAccount && (
          <IconButton label="Add account" icon={<UserPlus />} onClick={onAddAccount} />
        )}
        <UpdateButton />
      </div>
    </div>
  );
}

/** Checks for an update on click; once one is downloaded it lights up and restarts into it. */
function UpdateButton() {
  const available = useUpdateStore((s) => s.available);
  const applying = useUpdateStore((s) => s.applying);
  const checking = useUpdateStore((s) => s.manualCheck === "checking");

  if (available) {
    return (
      <IconButton
        className="sidebar__update sidebar__update--ready"
        label={`Restart to update to Pheeme ${displayVersion(available)}`}
        icon={<CircleArrowUp />}
        disabled={applying}
        onClick={() => void useUpdateStore.getState().apply()}
      />
    );
  }
  return (
    <IconButton
      className="sidebar__update"
      label={checking ? "Checking for updates…" : "Check for updates"}
      icon={<CircleArrowUp />}
      aria-busy={checking || undefined}
      onClick={() => {
        if (isTauri()) void checkForUpdatesNow();
        else toast({ title: "Updates are checked by the desktop app." });
      }}
    />
  );
}
