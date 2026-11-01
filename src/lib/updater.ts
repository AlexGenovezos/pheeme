import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { create } from "zustand";

export interface PendingUpdate {
  version: string;
  /** Download and install, without relaunching. */
  install(): Promise<void>;
}

export interface UpdaterDeps {
  check(): Promise<PendingUpdate | null>;
  relaunch(): Promise<void>;
  log(msg: string, err: unknown): void;
}

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const tauriDeps: UpdaterDeps = {
  check: async () => {
    const update = await check();
    return update && { version: update.version, install: () => update.downloadAndInstall() };
  },
  relaunch,
  log: (msg, err) => console.error(msg, err),
};

interface UpdateState {
  available: string | null;
  applying: boolean;
  apply(): Promise<void>;
}

let deps = tauriDeps;
let pending: PendingUpdate | null = null;
let checking = false;

const initialState: UpdateState = {
  available: null,
  applying: false,
  // Nothing downloads until the user clicks, so the Windows installer never appears unasked.
  // On Windows install() launches the NSIS installer and exits the app, so relaunch() is
  // never reached there; the tests cover the ordering, not that platform behavior.
  apply: async () => {
    if (!pending || useUpdateStore.getState().applying) return;
    useUpdateStore.setState({ applying: true });
    try {
      await pending.install();
      await deps.relaunch();
    } catch (err) {
      deps.log("update install failed", err);
      useUpdateStore.setState({ applying: false });
    }
  },
};

export const useUpdateStore = create<UpdateState>(() => initialState);

async function runCheck() {
  if (checking || pending) return;
  checking = true;
  try {
    const update = await deps.check();
    if (update) {
      pending = update;
      useUpdateStore.setState({ available: update.version });
    }
  } catch (err) {
    deps.log("update check failed", err);
  } finally {
    checking = false;
  }
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
  checking = false;
  useUpdateStore.setState(initialState, true);
}
