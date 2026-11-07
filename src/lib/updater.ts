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

/** Emitted by the macOS app menu's "Check for Updates…" item (src-tauri/src/app_menu.rs). */
export const CHECK_FOR_UPDATES_EVENT = "check-for-updates";

/** Outcome of a check the user asked for; background checks stay silent. */
export type ManualCheckStatus = "idle" | "checking" | "current" | "failed";

const tauriDeps: UpdaterDeps = {
  check: async () => {
    const update = await check();
    return update && { version: update.version, install: () => update.downloadAndInstall() };
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
    deps.report("available", update.version);
    pending = update;
    useUpdateStore.setState({ available: update.version });
    return "available";
  } catch (err) {
    deps.report("check_failed", undefined, err);
    return "failed";
  }
}

/** One check at a time: a caller arriving mid-check shares its result. */
function runCheck(): Promise<CheckResult> {
  if (pending) return Promise.resolve("available");
  inflight ??= doCheck().finally(() => {
    inflight = null;
  });
  return inflight;
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

export function startUpdateChecks(
  d: UpdaterDeps = tauriDeps,
  intervalMs = CHECK_INTERVAL_MS,
): () => void {
  deps = d;
  void runCheck();
  const id = setInterval(() => void runCheck(), intervalMs);
  return () => clearInterval(id);
}

export function __resetForTests() {
  pending = null;
  inflight = null;
  useUpdateStore.setState(initialState, true);
}
