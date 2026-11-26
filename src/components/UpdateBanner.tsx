import { useEffect, useState } from "react";
import { displayVersion, useUpdateStore } from "../lib/updater";
import { Button } from "./ui/Button";
import { CornerCard } from "./ui/CornerCard";

const manualCheckText = {
  checking: "Checking for updates…",
  current: "Pheeme is up to date",
  failed: "Couldn't check for updates. Try again later.",
} as const;

/** "Up to date" needs no answer, so it goes away by itself; a failure waits for OK. */
export const UP_TO_DATE_MS = 5_000;

/** Pinned under the toasts: an update is downloaded on click, then the app restarts. */
export function UpdateBanner() {
  const { available, applying, apply, manualCheck, dismissManualCheck } = useUpdateStore();
  // Hides only this card: Settings › About keeps saying it's up to date.
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (manualCheck !== "current") return;
    const id = setTimeout(() => setExpired(true), UP_TO_DATE_MS);
    return () => {
      clearTimeout(id);
      setExpired(false);
    };
  }, [manualCheck]);
  if (available) {
    return (
      <CornerCard
        title={`Pheeme ${displayVersion(available)} is ready`}
        action={
          <Button
            className="ui-toast__button"
            variant="primary"
            size="sm"
            disabled={applying}
            onClick={() => void apply()}
          >
            {applying ? "Updating…" : "Restart to update"}
          </Button>
        }
      />
    );
  }
  // Result of a "Check for Updates…" from the app menu; background checks stay silent.
  if (manualCheck === "idle" || (manualCheck === "current" && expired)) return null;
  return (
    <CornerCard
      title={manualCheckText[manualCheck]}
      // Shown from the start, so the card keeps its size when the result arrives.
      action={
        <Button
          className="ui-toast__button"
          size="sm"
          disabled={manualCheck === "checking"}
          onClick={dismissManualCheck}
        >
          OK
        </Button>
      }
    />
  );
}
