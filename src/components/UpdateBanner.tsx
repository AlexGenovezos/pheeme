import { displayVersion, useUpdateStore } from "../lib/updater";
import { Button } from "./ui/Button";
import "./ui/Toast.css";

/** Pinned under the toasts: an update is downloaded on click, then the app restarts. */
export function UpdateBanner() {
  const { available, applying, apply } = useUpdateStore();
  if (!available) return null;
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
