import { Button } from "../components/ui/Button";
import { useStatsStore } from "../stats/statsStore";
import { SettingsRow, SettingsSection } from "./rows";
import { useSettingsStore } from "./settingsStore";

/** Settings › Mail stats: the stats have their own window; this page points to it. */
export function MailStatsLink() {
  const open = () => {
    useSettingsStore.getState().close();
    useStatsStore.getState().openStats();
  };
  return (
    <SettingsSection title="Mail stats">
      <SettingsRow
        title="Mail stats"
        description="How much mail you get, where it lands, and who sends the most. Also in the sidebar, beside Settings."
        control={
          <Button size="sm" onClick={open}>
            Open
          </Button>
        }
      />
    </SettingsSection>
  );
}
