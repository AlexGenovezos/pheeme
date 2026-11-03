import { displayVersion, useUpdateStore } from "../lib/updater";
import { Button } from "./ui/Button";
import "./ui/Toast.css";

const manualCheckText = {
  checking: "Checking for updates…",
  current: "Pheeme is up to date",
  failed: "Couldn't check for updates. Try again later.",
} as const;

/** Pinned under the toasts: an update is downloaded on click, then the app restarts. */
export function UpdateBanner() {
  const { available, applying, apply, manualCheck, dismissManualCheck } = useUpdateStore();
  if (available) {
    return (
      <div role="status" className="ui-toast">
        <div className="ui-toast__text">
          <span className="ui-toast__title">Pheeme {displayVersion(available)} is ready</span>
        </div>
        <Button variant="primary" size="sm" disabled={applying} onClick={() => void apply()}>
          {applying ? "Updating…" : "Restart to update"}
        </Button>
      </div>
    );
  }
  // Result of a "Check for Updates…" from the app menu; background checks stay silent.
  if (manualCheck === "idle") return null;
  return (
    <div role="status" className="ui-toast">
      <div className="ui-toast__text">
        <span className="ui-toast__title">{manualCheckText[manualCheck]}</span>
      </div>
      {manualCheck !== "checking" && (
        <Button size="sm" onClick={dismissManualCheck}>
          OK
        </Button>
      )}
    </div>
  );
}
