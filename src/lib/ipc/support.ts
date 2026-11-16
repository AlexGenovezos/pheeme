import { call } from "./call";

/**
 * Upload a scrubbed diagnostics bundle with the user's note (sent as typed). Rejects with `rate_limited`,
 * `network`, `rejected` or `too_large`.
 */
export const sendDiagnostics = (
  note: string,
  replyTo: string | null,
  email?: DiagnosticsEmail,
  screenshots: string[] = [],
) =>
  call("send_diagnostics", {
    note,
    replyTo,
    ...(email ? { email } : {}),
    ...(screenshots.length ? { screenshots } : {}),
  });
/** A screenshot checked and re-encoded by Rust: a PNG (base64) written from the file's pixels alone. */
export interface PreparedScreenshot {
  png: string;
  width: number;
  height: number;
}
/**
 * Check a screenshot for a diagnostics report, from its bytes (base64) or a dropped file's path. A PNG or
 * JPEG comes back as a clean PNG, scaled to fit; anything else rejects with `invalid_input`.
 */
export const prepareScreenshot = (source: { data: string } | { path: string }) =>
  call("prepare_screenshot", source);
/** The email on screen, added to a diagnostics bundle when the user chooses (`support::email` in Rust). */
export interface DiagnosticsEmail {
  accountId: string;
  threadId: string;
  images: DiagnosticsImage[];
}
/** One `<img>` in the email's frames, as the window saw it. */
export interface DiagnosticsImage {
  messageId: string | null;
  src: string;
  currentSrc: string;
  complete: boolean;
  naturalWidth: number;
  naturalHeight: number;
  loading: string;
}
/** Updater steps the UI saw; `log_update` in Rust writes them to the diagnostics log. */
export type UpdateEvent =
  | "available"
  | "up_to_date"
  | "check_failed"
  | "downloaded"
  | "download_failed"
  | "auto_restart"
  | "installing"
  | "installed"
  | "install_failed"
  | "listener_failed";
/** Log one updater step with the version it concerns and any error, for Send diagnostics. */
export const logUpdate = (event: UpdateEvent, version: string | null, error: string | null) =>
  call("log_update", { event, version, error });
/** Keep the window hidden on the next launch: an update is about to restart Pheeme while it sits in the tray. */
export const startHiddenNextLaunch = () => call("start_hidden_next_launch");
/** Whether this launch is an update's restart from the tray, which leaves the window hidden. */
export const launchHidden = () => call("launch_hidden");
/**
 * What the user waited for after picking a conversation, measured in the window: `get_thread` times only the
 * backend, and a conversation already in memory never calls it. Milliseconds from the pick; no ids or subjects.
 */
export interface ShownTiming {
  /** `shown`: painted with every image settled; `left`: the user moved on first; `timed_out`: gave up waiting. */
  outcome: "shown" | "left" | "timed_out";
  /** The conversation was already in memory, so no `get_thread` ran. */
  fromMemory: boolean;
  /** Until the conversation's data was in hand, or null if it never was. */
  dataMs: number | null;
  /** Until the first frame painted with it. */
  paintMs: number | null;
  /** Until every image in its email bodies loaded or failed; null when there were none or it never happened. */
  imagesMs: number | null;
  images: number;
  imagesFailed: number;
  /** Of the failed images, those served over plain `http:`. */
  imagesFailedHttp: number;
  imagesPending: number;
  totalMs: number;
}
/** Log how long a conversation took to show, for Send diagnostics. */
export const logThreadShown = (timing: ShownTiming) => call("log_thread_shown", { timing });
/** Whether the daily anonymous usage ping is on (it is unless the user turned it off). */
export const telemetryEnabled = () => call("telemetry_enabled");
/** Turn the anonymous usage ping on or off; off also forgets the install ID. Returns the stored choice. */
export const setTelemetry = (enabled: boolean) => call("set_telemetry", { enabled });
/** Write the same bundle to `path` (chosen in a save dialog). */
export const saveDiagnostics = (
  note: string,
  replyTo: string | null,
  path: string,
  email?: DiagnosticsEmail,
  screenshots: string[] = [],
) =>
  call("save_diagnostics", {
    note,
    replyTo,
    path,
    ...(email ? { email } : {}),
    ...(screenshots.length ? { screenshots } : {}),
  });
