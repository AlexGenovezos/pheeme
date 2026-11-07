import { useEffect, useState } from "react";
import type { ThreadLoading as Loading } from "../lib/tauri";
import { cx } from "../lib/utils";
import { useSettingsStore } from "../settings/settingsStore";
import "./mail.css";

/** Cached opens answer well inside this, so they never show the loading state. */
export const LOADING_DELAY_MS = 300;
/** After this long the user is offered a way to tell the developer. */
export const DIAGNOSTICS_HINT_MS = 15_000;

/** What the open is waiting on, in words. Without a stage from the backend, the plain version. */
export function loadingMessage(loading?: Loading): string {
  if (loading?.stage === "retrying") {
    if (loading.reason === "rate_limited") {
      const wait =
        loading.retryInMs === null
          ? ""
          : ` in ${Math.max(1, Math.ceil(loading.retryInMs / 1000))} s`;
      return `Gmail is asking Pheeme to slow down. Retrying${wait}…`;
    }
    return loading.attempt === null
      ? "Gmail isn't answering. Retrying…"
      : `Gmail isn't answering. Retrying (attempt ${loading.attempt + 1})…`;
  }
  if (loading?.syncBusy && (loading.stage === "queued" || loading.stage === "fetching")) {
    return "Pheeme is still downloading your mailbox for the first time. This message is next in line.";
  }
  return "Downloading this message from Gmail…";
}

/**
 * A quiet line saying what an open is waiting on. Shows nothing for `delayMs` (so quick opens don't flash),
 * and after 15 s adds a link to send diagnostics. Mount it fresh for each wait: the clock starts on mount.
 */
export function ThreadLoading({
  loading,
  delayMs = LOADING_DELAY_MS,
  className,
}: {
  loading?: Loading;
  delayMs?: number;
  className?: string;
}) {
  const [phase, setPhase] = useState<"hidden" | "shown" | "slow">(delayMs > 0 ? "hidden" : "shown");

  useEffect(() => {
    const show = setTimeout(() => setPhase((p) => (p === "hidden" ? "shown" : p)), delayMs);
    const slow = setTimeout(() => setPhase("slow"), DIAGNOSTICS_HINT_MS);
    return () => {
      clearTimeout(show);
      clearTimeout(slow);
    };
  }, [delayMs]);

  if (phase === "hidden") return null;
  return (
    <div className={cx("thread-loading", className)} role="status">
      <span className="thread-loading__mark" aria-hidden="true" />
      <p className="thread-loading__text">{loadingMessage(loading)}</p>
      {phase === "slow" && (
        <button
          type="button"
          className="link-button thread-loading__help"
          onClick={() => useSettingsStore.getState().openSettings("diagnostics")}
        >
          Taking too long? Send diagnostics
        </button>
      )}
    </div>
  );
}
