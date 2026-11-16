import { getCurrentWindow } from "@tauri-apps/api/window";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import { toast } from "../components/ui/Toast";
import { useComposeStore } from "../compose/composeStore";
import { readItem, writeItem } from "./storage";
import { createSubscriptionScope } from "./subscriptions";
import {
  CHECK_FOR_UPDATES_EVENT,
  listen,
  logUpdate,
  startHiddenNextLaunch,
  type UpdateEvent,
} from "./tauri";

export interface PendingUpdate {
  version: string;
  /** Fetch the package ahead of installing it; absent when there is nothing to fetch ahead. */
  download?(): Promise<void>;
  /**
   * Install (downloading first if needed), without relaunching. `restart: false` is for quitting: the Windows
   * installer then doesn't start the app again afterwards.
   */
  install(opts?: { restart?: boolean }): Promise<void>;
  /** Release the update's native handle once a newer one replaces it. */
  close?(): Promise<void>;
}

export interface UpdaterDeps {
  check(): Promise<PendingUpdate | null>;
  relaunch(): Promise<void>;
  /**
   * Save every message being written to Gmail Drafts, before the app goes away. False when one couldn't be
   * saved (its panel says why).
   */
  saveDrafts?(): Promise<boolean>;
  /** Record an updater step in the diagnostics log; must not throw. */
  report(event: UpdateEvent, version?: string, err?: unknown): void;
  /** Whether the window is shown (minimized counts as shown) and has focus; without it, no automatic restarts. */
  windowState?(): Promise<{ visible: boolean; focused: boolean }>;
  /** True while something would be lost or interrupted by a restart: a message being written, an open dialog. */
  busy?(): boolean;
  /** Ask the next launch to keep the window hidden. */
  startHidden?(): Promise<void>;
}

/** Public versions are two-part; the files store a trailing `.0` patch. */
export const displayVersion = (v: string) => v.replace(/^(\d+\.\d+)\.0$/, "$1");

export const CHECK_INTERVAL_MS = 30 * 60 * 1000;
/** A downloaded update installs and restarts Pheeme once its window has been hidden this long… */
export const IDLE_HIDDEN_MS = 10 * 60 * 1000;
/** …or shown but not in front this long. */
export const IDLE_UNFOCUSED_MS = 60 * 60 * 1000;
/** A gap this long between ticks means the computer slept: time asleep doesn't count as unused. */
const SLEPT_MS = 10 * 60 * 1000;
/** Settings › About › Install updates automatically (on unless turned off). */
export const AUTO_UPDATE_KEY = "pheeme.auto-update";
/** How soon a failed check is retried, e.g. when the network was not back yet after a wake. */
export const RETRY_MS = 15 * 60 * 1000;
/** How often the timer compares the clock with the next due check (timers stop during sleep). */
const TICK_MS = 60 * 1000;
/** A check that hangs would block every later check, so give up on it. */
const CHECK_TIMEOUT_MS = 60 * 1000;

/** Outcome of a check the user asked for; background checks stay silent. */
export type ManualCheckStatus = "idle" | "checking" | "current" | "failed";

/** Anything open that a restart would lose or interrupt: a message being written, a dialog, the setup guide. */
function appBusy() {
  if (useComposeStore.getState().windows.length > 0) return true;
  return document.querySelector('[role="dialog"], [aria-modal="true"], .onboarding') !== null;
}

const tauriDeps: UpdaterDeps = {
  check: async () => {
    const update = await check({ timeout: CHECK_TIMEOUT_MS });
    if (!update) return null;
    let downloaded: Promise<void> | null = null;
    const download = () =>
      (downloaded ??= update.download().catch((err: unknown) => {
        downloaded = null;
        throw err;
      }));
    return {
      version: update.version,
      download,
      install: async (opts) => {
        await download();
        await update.install(opts?.restart === false ? { restartAfterInstall: false } : undefined);
      },
      close: () => update.close(),
    };
  },
  relaunch,
  saveDrafts: () => useComposeStore.getState().saveAll(),
  report: (event, version, err) => {
    if (err !== undefined) console.error(`update ${event}`, err);
    const error = err === undefined ? null : String(err instanceof Error ? err.message : err);
    logUpdate(event, version ?? null, error).catch(() => {});
  },
  windowState: async () => {
    const win = getCurrentWindow();
    const [visible, focused] = await Promise.all([win.isVisible(), win.isFocused()]);
    return { visible, focused };
  },
  busy: appBusy,
  startHidden: startHiddenNextLaunch,
};

interface UpdateState {
  /** The version downloaded and ready to install. */
  available: string | null;
  applying: boolean;
  manualCheck: ManualCheckStatus;
  /** Install a downloaded update when Pheeme is unused, and when it quits. */
  auto: boolean;
  apply(): Promise<void>;
  setAuto(on: boolean): void;
  dismissManualCheck(): void;
}

type CheckResult = "available" | "none" | "failed";

let deps = tauriDeps;
let pending: PendingUpdate | null = null;
/** Whether `pending` is downloaded. */
let ready = false;
let downloading: { update: PendingUpdate; done: Promise<boolean> } | null = null;
/** The version whose automatic install failed: not retried until a newer one or the next launch. */
let autoFailed: string | null = null;
/** When the window was last seen hidden / not in front, while it still is; null while shown / in front. */
let hiddenSince: number | null = null;
let unfocusedSince: number | null = null;
let lastIdleTick = 0;
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
  auto: readItem(AUTO_UPDATE_KEY) !== "0",
  dismissManualCheck: () => useUpdateStore.setState({ manualCheck: "idle" }),
  setAuto: (on) => {
    writeItem(AUTO_UPDATE_KEY, on ? "1" : "0");
    useUpdateStore.setState({ auto: on });
  },
  apply: () => installAndRestart({ auto: false, hidden: false }),
};

export const useUpdateStore = create<UpdateState>(() => initialState);

/**
 * Install the downloaded update and restart. A click first checks again, since the update on offer may be hours old: installing
 * it when a newer release is out would mean a second update right after the restart. Either way the app
 * goes away, so messages being written are saved to Drafts first, and nothing is installed while one of
 * them can't be. On Windows install() launches the installer and exits the app, so relaunch() is never
 * reached there; the tests cover the ordering, not that platform behavior.
 */
async function installAndRestart(how: { auto: boolean; hidden: boolean }) {
  if (!pending || useUpdateStore.getState().applying) return;
  useUpdateStore.setState({ applying: true });
  const saved = await (deps.saveDrafts?.() ?? Promise.resolve(true)).catch(() => false);
  if (!saved) {
    useUpdateStore.setState({ applying: false });
    if (!how.auto)
      toast({
        title: "Update not installed",
        description: "A draft couldn't be saved. Save or discard it, then update again.",
        tone: "danger",
      });
    return;
  }
  if (!how.auto) await doCheck(true);
  const { version } = pending;
  try {
    if (how.auto) deps.report("auto_restart", version);
    if (how.hidden) await deps.startHidden?.();
    deps.report("installing", version);
    await pending.install();
    deps.report("installed", version);
    await deps.relaunch();
  } catch (err) {
    deps.report("install_failed", version, err);
    if (how.auto) autoFailed = version;
    useUpdateStore.setState({ applying: false });
  }
}

/** Offer `update` in place of any other: download it, then show it as ready. */
function offer(update: PendingUpdate) {
  deps.report("available", update.version);
  if (pending) release(pending);
  pending = update;
  ready = !update.download;
  // The banner offers only what's downloaded: the one it showed is gone.
  useUpdateStore.setState({ available: ready ? update.version : null });
}

/** Download the update on offer, once; true when it's ready to install. */
function fetchPending(): Promise<boolean> {
  const update = pending;
  if (!update) return Promise.resolve(false);
  if (ready) return Promise.resolve(true);
  if (downloading?.update === update) return downloading.done;
  const done = update.download!().then(
    () => {
      if (pending !== update) return false;
      ready = true;
      deps.report("downloaded", update.version);
      useUpdateStore.setState({ available: update.version });
      return true;
    },
    (err: unknown) => {
      deps.report("download_failed", update.version, err);
      return false;
    },
  );
  downloading = { update, done };
  void done.then(() => {
    if (downloading?.done === done) downloading = null;
  });
  return done;
}

/** `forApply`: the check `apply` runs before installing, so it may still swap the update. */
async function doCheck(forApply = false): Promise<CheckResult> {
  let update: PendingUpdate | null;
  try {
    update = await deps.check();
  } catch (err) {
    deps.report("check_failed", undefined, err);
    return "failed";
  }
  if (!update) {
    deps.report("up_to_date");
    return "none";
  }
  // Keep the update already offered unless this one is newer, and never swap mid-install.
  const installing = !forApply && useUpdateStore.getState().applying;
  if (installing || (pending && !isNewer(update.version, pending.version))) release(update);
  else offer(update);
  // apply() installs straight after, downloading as it goes.
  if (installing || forApply) return "available";
  return (await fetchPending()) ? "available" : "failed";
}

/** Whether to install the downloaded update and restart now, unasked (see `IDLE_HIDDEN_MS`). */
function dueForAutoRestart(now: number) {
  const { auto, applying } = useUpdateStore.getState();
  if (!pending || !ready || !auto || applying || autoFailed === pending.version) return false;
  const idle =
    (hiddenSince !== null && now - hiddenSince >= IDLE_HIDDEN_MS) ||
    (unfocusedSince !== null && now - unfocusedSince >= IDLE_UNFOCUSED_MS);
  return idle && !(deps.busy?.() ?? false);
}

/** Note how long the window has been hidden or in the background, and restart into the update when due. */
async function idleTick() {
  if (!deps.windowState) return;
  let win: { visible: boolean; focused: boolean };
  try {
    win = await deps.windowState();
  } catch {
    return;
  }
  const now = Date.now();
  // A window left open overnight counts from the wake, so the restart doesn't greet the user on return.
  const slept = now - lastIdleTick >= SLEPT_MS;
  lastIdleTick = now;
  if (win.focused) unfocusedSince = null;
  else if (unfocusedSince === null || slept) unfocusedSince = now;
  if (win.visible) hiddenSince = null;
  else hiddenSince ??= now;
  if (dueForAutoRestart(now)) await installAndRestart({ auto: true, hidden: !win.visible });
}

/**
 * Pheeme is quitting with an update downloaded: install it on the way out, so the next launch is current.
 * Called once open messages are saved; on Windows the installer takes over and the app exits here.
 */
export async function installBeforeQuit(): Promise<void> {
  const { auto, applying } = useUpdateStore.getState();
  if (!pending || !ready || !auto || applying || autoFailed === pending.version) return;
  const { version } = pending;
  useUpdateStore.setState({ applying: true });
  try {
    deps.report("installing", version);
    await pending.install({ restart: false });
    deps.report("installed", version);
  } catch (err) {
    deps.report("install_failed", version, err);
    autoFailed = version;
    useUpdateStore.setState({ applying: false });
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

/** The window was just used: the idle waits start over. */
function noteActive() {
  hiddenSince = null;
  unfocusedSince = null;
}

function tick() {
  checkIfDue();
  void idleTick();
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
 * Check now, then every `interval`, downloading what it finds. Also catches up when the window comes back
 * into view or gets focus (e.g. after a wake or opening from the tray), and retries a failed check as soon
 * as the network returns. Every minute it also looks at whether Pheeme is in use, to restart into a
 * downloaded update when it isn't.
 */
export function startUpdateChecks(
  d: UpdaterDeps = tauriDeps,
  interval = CHECK_INTERVAL_MS,
): () => void {
  deps = d;
  intervalMs = interval;
  void runCheck();
  void idleTick();
  const id = setInterval(tick, Math.min(TICK_MS, interval));
  const onVisible = () => {
    if (document.visibilityState === "visible") onFocus();
  };
  const onFocus = () => {
    noteActive();
    checkIfDue();
  };
  const onOnline = () => (lastResult === "failed" ? void runCheck() : checkIfDue());
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onFocus);
  window.addEventListener("online", onOnline);
  return () => {
    clearInterval(id);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("online", onOnline);
  };
}

export function __resetForTests() {
  pending = null;
  ready = false;
  downloading = null;
  autoFailed = null;
  hiddenSince = null;
  unfocusedSince = null;
  lastIdleTick = 0;
  inflight = null;
  nextCheckAt = 0;
  intervalMs = CHECK_INTERVAL_MS;
  lastResult = null;
  useUpdateStore.setState({ ...initialState, auto: true }, true);
}
