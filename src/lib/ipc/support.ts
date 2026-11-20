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
  /** `navigator.onLine` when Send was pressed. */
  online: boolean;
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
  /** How many times the window fetched it again after it failed (`src/mail/imageRetry.ts`). */
  retries: number;
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
/**
 * How one attachment preview went, measured in the window (`src/mail/preview/trace.ts`), so a "the PDF is blank"
 * report says which step failed. No file name, contents or ids.
 */
export interface PreviewReport {
  /** The reader that showed it: `pdf`, `docx`, `pptx`, `xlsx`, `csv`, `image` or `text`. */
  kind: string;
  /** The attachment's size as Gmail lists it. */
  bytes: number | null;
  /**
   * `shown`: something was drawn. `blank`: every drawn page came out a single colour. `not_drawn`: the file was read
   * but no page was drawn before the preview closed. `load_failed`: its bytes couldn't be fetched. `read_failed`: the
   * reader couldn't parse them. `render_failed`: pages failed to draw. `left`: closed while still loading.
   */
  outcome:
    | "shown"
    | "blank"
    | "not_drawn"
    | "load_failed"
    | "read_failed"
    | "render_failed"
    | "left";
  /** Until the bytes were in hand. */
  loadMs: number | null;
  /** Until the reader had parsed them (a PDF's page sizes known). */
  readMs: number | null;
  /** Until the first page (or the whole file, for readers without pages) was drawn. */
  shownMs: number | null;
  /** Pages (or slides) in the file, when the reader counts them. */
  pages: number | null;
  /** Pages drawn, and how many of those came out blank. */
  drawn: number;
  blank: number;
  /** The first drawn page's canvas size in device pixels (`1600x2070`), and the window's pixel ratio. */
  canvas: string | null;
  pixelRatio: number;
  /** Failures seen, and the first one as `stage: Name: message | first stack frames`. */
  errors: number;
  error: string | null;
  totalMs: number;
}
/** Log how an attachment preview went, for Send diagnostics. */
export const logPreview = (report: PreviewReport) => call("log_preview", { report });
/**
 * A problem in the window, for Send diagnostics: an uncaught error or promise rejection, or the window's main thread
 * falling behind while it was on screen (`src/diagnostics/windowProblems.ts`). No email content.
 */
export interface WindowProblem {
  kind: "error" | "rejection" | "stall";
  /** The error as `Name: message` with the first stack frames (errors and rejections). */
  message: string | null;
  /** How far behind the main thread fell (stalls). */
  lagMs: number | null;
  /** Repeats of the same problem folded into this report since the last one. */
  repeats: number;
  /** Whether the window was visible and focused at the time. */
  visible: boolean;
  focused: boolean;
}
/** Log a problem in the window, for Send diagnostics. */
export const logWindowProblem = (problem: WindowProblem) => call("log_window_problem", { problem });
/** Whether the daily anonymous usage ping is on (it is unless the user turned it off). */
export const telemetryEnabled = () => call("telemetry_enabled");
/** Turn the anonymous usage ping on or off; off also forgets the install ID. Returns the stored choice. */
export const setTelemetry = (enabled: boolean) => call("set_telemetry", { enabled });
/** Counts for the anonymous usage report (`src/usage/`): screens opened and their time on screen,
 * commands run by how, and the user's rebound shortcuts (`key: null` = removed). */
export interface UsageBatch {
  screens: Array<{ name: string; opens: number; ms: number }>;
  commands: Array<{ id: string; source: "key" | "palette" | "button"; count: number }>;
  rebound?: Array<{ id: string; key: string | null }>;
}
/** Add counts to today's anonymous usage report; a no-op while usage stats are off. */
export const recordUsage = (batch: UsageBatch) => call("record_usage", { batch });
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
