import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import { createSubscriptionScope } from "./subscriptions";
import { logUpdate, type UpdateEvent } from "./tauri";

export interface PendingUpdate {
  version: string;
  /** Download and install, without relaunching. */
  install(): Promise<void>;
  /** Release the update's native handle once a newer one replaces it. */
  close?(): Promise<void>;
}

export interface UpdaterDeps {
  check(): Promise<PendingUpdate | null>;
  relaunch(): Promise<void>;
  /** Record an updater step in the diagnostics log; must not throw. */
  report(event: UpdateEvent, version?: string, err?: unknown): void;
}

/** Public versions are two-part; the files store a trailing `.0` patch. */
export const displayVersion = (v: string) => v.replace(/^(\d+\.\d+)\.0$/, "$1");

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** How soon a failed check is retried, e.g. when the network was not back yet after a wake. */
export const RETRY_MS = 15 * 60 * 1000;
/** How often the timer compares the clock with the next due check (timers stop during sleep). */
const TICK_MS = 60 * 1000;
/** A check that hangs would block every later check, so give up on it. */
const CHECK_TIMEOUT_MS = 60 * 1000;

/** Emitted by the macOS app menu's "Check for Updates…" item (src-tauri/src/app_menu.rs). */
export const CHECK_FOR_UPDATES_EVENT = "check-for-updates";

/** Outcome of a check the user asked for; background checks stay silent. */
export type ManualCheckStatus = "idle" | "checking" | "current" | "failed";

const tauriDeps: UpdaterDeps = {
  check: async () => {
    const update = await check({ timeout: CHECK_TIMEOUT_MS });
    return (
      update && {
        version: update.version,
        install: () => update.downloadAndInstall(),
        close: () => update.close(),
      }
    );
  },
  relaunch,
  report: (event, version, err) => {
    if (err !== undefined) console.error(`update ${event}`, err);
    const error = err === undefined ? null : String(err instanceof Error ? err.message : err);
    logUpdate(event, version ?? null, error).catch(() => {});
  },
};

interface UpdateState {
  available: string | null;
  applying: boolean;
  manualCheck: ManualCheckStatus;
  apply(): Promise<void>;
  dismissManualCheck(): void;
}

type CheckResult = "available" | "none" | "failed";

let deps = tauriDeps;
let pending: PendingUpdate | null = null;
let inflight: Promise<CheckResult> | null = null;
/** Wall-clock time of the next background check; 0 means as soon as possible. */
let nextCheckAt = 0;
let intervalMs = CHECK_INTERVAL_MS;
let lastResult: CheckResult | null = null;

/** Numeric compare of dotted versions ("0.12.0" > "0.9.0"); suffixes are ignored. */
function isNewer(a: string, b: string) {
  const [x, y] = [a, b].map((v) => v.split(/[.+-]/).slice(0, 3).map(Number));
  const i = x.findIndex((n, k) => n !== y[k]);
  return i !== -1 && x[i] > y[i];
}

function release(update: PendingUpdate) {
  update.close?.().catch(() => {});
}

const initialState: UpdateState = {
  available: null,
  applying: false,
  manualCheck: "idle",
  dismissManualCheck: () => useUpdateStore.setState({ manualCheck: "idle" }),
  // Nothing downloads until the user clicks, so the Windows installer never appears unasked.
  // On Windows install() launches the NSIS installer and exits the app, so relaunch() is
  // never reached there; the tests cover the ordering, not that platform behavior.
  apply: async () => {
    if (!pending || useUpdateStore.getState().applying) return;
    useUpdateStore.setState({ applying: true });
    const { version } = pending;
    try {
      deps.report("installing", version);
      await pending.install();
      deps.report("installed", version);
      await deps.relaunch();
    } catch (err) {
      deps.report("install_failed", version, err);
      useUpdateStore.setState({ applying: false });
    }
  },
};

export const useUpdateStore = create<UpdateState>(() => initialState);

async function doCheck(): Promise<CheckResult> {
  try {
    const update = await deps.check();
    if (!update) {
      deps.report("up_to_date");
      return "none";
    }
    // Keep the update already offered unless this one is newer, and never swap mid-install.
    const keep = pending && !isNewer(update.version, pending.version);
    if (keep || useUpdateStore.getState().applying) {
      release(update);
      return "available";
    }
    deps.report("available", update.version);
    if (pending) release(pending);
    pending = update;
    useUpdateStore.setState({ available: update.version });
    return "available";
  } catch (err) {
    deps.report("check_failed", undefined, err);
    return "failed";
  }
}

/**
 * One check at a time: a caller arriving mid-check shares its result. Checks keep running
 * after an update is found, so a release published later replaces the one on offer.
 */
function runCheck(): Promise<CheckResult> {
  if (useUpdateStore.getState().applying) return Promise.resolve("available");
  inflight ??= doCheck().then((result) => {
    lastResult = result;
    nextCheckAt = Date.now() + (result === "failed" ? RETRY_MS : intervalMs);
    inflight = null;
    return result;
  });
  return inflight;
}

/** Check if the next check is due. Comparing the clock catches up after the computer sleeps. */
function checkIfDue() {
  if (Date.now() >= nextCheckAt) void runCheck();
}

/** A check the user asked for: reports "checking", then "up to date" or failure. */
export async function checkForUpdatesNow(): Promise<void> {
  const { available, manualCheck } = useUpdateStore.getState();
  if (available || manualCheck === "checking") return;
  useUpdateStore.setState({ manualCheck: "checking" });
  const result = await runCheck();
  const outcome = { available: "idle", none: "current", failed: "failed" } as const;
  useUpdateStore.setState({ manualCheck: outcome[result] });
}

/** Run a manual check whenever the app menu asks for one. Returns an unsubscribe. */
export function listenForManualChecks(): () => void {
  const log = (err: unknown) => deps.report("listener_failed", undefined, err);
  const scope = createSubscriptionScope();
  scope.add(() => listen(CHECK_FOR_UPDATES_EVENT, () => void checkForUpdatesNow())).catch(log);
  return scope.dispose;
}

/**
 * Check now, then every `interval`. Also catches up when the window comes back into view or
 * gets focus (e.g. after a wake or opening from the tray), and retries a failed check as soon
 * as the network returns.
 */
export function startUpdateChecks(
  d: UpdaterDeps = tauriDeps,
  interval = CHECK_INTERVAL_MS,
): () => void {
  deps = d;
  intervalMs = interval;
  void runCheck();
  const id = setInterval(checkIfDue, Math.min(TICK_MS, interval));
  const onVisible = () => {
    if (document.visibilityState === "visible") checkIfDue();
  };
  const onOnline = () => (lastResult === "failed" ? void runCheck() : checkIfDue());
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", checkIfDue);
  window.addEventListener("online", onOnline);
  return () => {
    clearInterval(id);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", checkIfDue);
    window.removeEventListener("online", onOnline);
  };
}

export function __resetForTests() {
  pending = null;
  inflight = null;
  nextCheckAt = 0;
  intervalMs = CHECK_INTERVAL_MS;
  lastResult = null;
  useUpdateStore.setState(initialState, true);
}
