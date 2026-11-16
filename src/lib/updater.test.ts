import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { dismissToast, useToastStore } from "../components/ui/Toast";
import { CHECK_FOR_UPDATES_EVENT } from "./tauri";
import {
  AUTO_UPDATE_KEY,
  CHECK_INTERVAL_MS,
  IDLE_HIDDEN_MS,
  IDLE_UNFOCUSED_MS,
  RETRY_MS,
  __resetForTests,
  checkForUpdatesNow,
  displayVersion,
  installBeforeQuit,
  listenForManualChecks,
  startUpdateChecks,
  useUpdateStore,
  type PendingUpdate,
  type UpdaterDeps,
} from "./updater";

vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(async () => {}) }));

let stop: () => void = () => {};

function fakeDeps(check: UpdaterDeps["check"]) {
  return { check: vi.fn(check), relaunch: vi.fn(async () => {}), report: vi.fn() };
}

function fakeUpdate(install: PendingUpdate["install"] = async () => {}, version = "0.2.0") {
  return { version, install: vi.fn(install), close: vi.fn(async () => {}) };
}

/** The computer sleeps: the clock moves on but no timers fire. */
function sleepFor(ms: number) {
  vi.setSystemTime(Date.now() + ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetForTests();
  useToastStore.getState().toasts.forEach((t) => dismissToast(t.id));
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

test("checks on start and again after the interval", async () => {
  const deps = fakeDeps(async () => null);
  stop = startUpdateChecks(deps);
  await vi.advanceTimersByTimeAsync(0);
  expect(deps.check).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
  expect(deps.check).toHaveBeenCalledTimes(2);
});

test("stores the available version", async () => {
  stop = startUpdateChecks(fakeDeps(async () => fakeUpdate()));
  await vi.advanceTimersByTimeAsync(0);
  expect(useUpdateStore.getState().available).toBe("0.2.0");
});

test("keeps checking after an update is found and offers a newer release", async () => {
  const first = fakeUpdate(undefined, "0.2.0");
  const newer = fakeUpdate(undefined, "0.3.0");
  const deps = fakeDeps(async () => first);
  stop = startUpdateChecks(deps);
  await vi.advanceTimersByTimeAsync(0);
  deps.check.mockImplementation(async () => newer);
  await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
  expect(deps.check).toHaveBeenCalledTimes(2);
  expect(useUpdateStore.getState().available).toBe("0.3.0");
  expect(first.close).toHaveBeenCalled();

  await useUpdateStore.getState().apply();
  expect(newer.install).toHaveBeenCalled();
  expect(first.install).not.toHaveBeenCalled();
});

test("keeps the offered update when the same release comes back", async () => {
  const first = fakeUpdate();
  const again = fakeUpdate();
  const deps = fakeDeps(async () => first);
  stop = startUpdateChecks(deps);
  await vi.advanceTimersByTimeAsync(0);
  deps.check.mockImplementation(async () => again);
  await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
  expect(again.close).toHaveBeenCalled();
  expect(first.close).not.toHaveBeenCalled();
  expect(deps.report.mock.calls).toEqual([["available", "0.2.0"]]);

  await useUpdateStore.getState().apply();
  expect(first.install).toHaveBeenCalled();
});

test("keeps the newer update when a stale check returns an older release", async () => {
  const newer = fakeUpdate(undefined, "0.10.0");
  const older = fakeUpdate(undefined, "0.9.0");
  const deps = fakeDeps(async () => newer);
  stop = startUpdateChecks(deps);
  await vi.advanceTimersByTimeAsync(0);
  deps.check.mockImplementation(async () => older);
  await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
  expect(useUpdateStore.getState().available).toBe("0.10.0");
  expect(older.close).toHaveBeenCalled();
  expect(newer.close).not.toHaveBeenCalled();
});

test("does not swap the update while it installs", async () => {
  let finish!: () => void;
  const first = fakeUpdate(() => new Promise<void>((r) => (finish = r)));
  const deps = fakeDeps(async () => first);
  stop = startUpdateChecks(deps);
  await vi.advanceTimersByTimeAsync(0);
  const applying = useUpdateStore.getState().apply();
  await vi.advanceTimersByTimeAsync(0);
  expect(first.install).toHaveBeenCalled();
  deps.check.mockImplementation(async () => fakeUpdate(undefined, "0.3.0"));
  await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
  // The launch check and the one apply runs before installing; none while installing.
  expect(deps.check).toHaveBeenCalledTimes(2);
  finish();
  await applying;
  expect(useUpdateStore.getState().available).toBe("0.2.0");
});

test("a check that finishes during an install leaves the update alone", async () => {
  let resolve!: (u: PendingUpdate | null) => void;
  const first = fakeUpdate(() => new Promise<void>(() => {}));
  const deps = fakeDeps(async () => first);
  stop = startUpdateChecks(deps);
  await vi.advanceTimersByTimeAsync(0);
  deps.check.mockImplementation(() => new Promise((r) => (resolve = r)));
  await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
  const background = resolve;
  deps.check.mockImplementation(async () => fakeUpdate(undefined, "0.2.0"));
  void useUpdateStore.getState().apply();
  await vi.advanceTimersByTimeAsync(0);
  expect(first.install).toHaveBeenCalled();
  const late = fakeUpdate(undefined, "0.3.0");
  background(late);
  await vi.advanceTimersByTimeAsync(0);
  expect(useUpdateStore.getState().available).toBe("0.2.0");
  expect(late.close).toHaveBeenCalled();
});

test("apply installs a release published since the update was offered", async () => {
  const first = fakeUpdate(undefined, "0.2.0");
  const newer = fakeUpdate(undefined, "0.3.0");
  const deps = fakeDeps(async () => first);
  stop = startUpdateChecks(deps);
  await vi.advanceTimersByTimeAsync(0);
  deps.check.mockImplementation(async () => newer);

  await useUpdateStore.getState().apply();

  expect(newer.install).toHaveBeenCalled();
  expect(first.install).not.toHaveBeenCalled();
  expect(first.close).toHaveBeenCalled();
  expect(deps.relaunch).toHaveBeenCalledTimes(1);
  expect(deps.report.mock.calls).toEqual([
    ["available", "0.2.0"],
    ["available", "0.3.0"],
    ["installing", "0.3.0"],
    ["installed", "0.3.0"],
  ]);
});

test("apply installs the offered update when checking again fails", async () => {
  const first = fakeUpdate();
  const deps = fakeDeps(async () => first);
  stop = startUpdateChecks(deps);
  await vi.advanceTimersByTimeAsync(0);
  deps.check.mockImplementation(async () => {
    throw new Error("offline");
  });

  await useUpdateStore.getState().apply();

  expect(first.install).toHaveBeenCalled();
  expect(deps.relaunch).toHaveBeenCalledTimes(1);
});

test("catches up on the next tick after the computer wakes", async () => {
  const deps = fakeDeps(async () => null);
  stop = startUpdateChecks(deps);
  await vi.advanceTimersByTimeAsync(0);
  sleepFor(CHECK_INTERVAL_MS);
  await vi.advanceTimersByTimeAsync(60 * 1000);
  expect(deps.check).toHaveBeenCalledTimes(2);
});

test("checks when the window comes back if a check is due", async () => {
  const deps = fakeDeps(async () => null);
  stop = startUpdateChecks(deps);
  await vi.advanceTimersByTimeAsync(0);
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(0);
  expect(deps.check).toHaveBeenCalledTimes(1);

  sleepFor(CHECK_INTERVAL_MS);
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(0);
  expect(deps.check).toHaveBeenCalledTimes(2);

  sleepFor(CHECK_INTERVAL_MS);
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(deps.check).toHaveBeenCalledTimes(3);
});

test("retries a failed check when the network comes back", async () => {
  const deps = fakeDeps(async () => {
    throw new Error("offline");
  });
  stop = startUpdateChecks(deps);
  await vi.advanceTimersByTimeAsync(0);
  deps.check.mockImplementation(async () => null);
  window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(0);
  expect(deps.check).toHaveBeenCalledTimes(2);

  // Back online after a good check: nothing is due yet.
  window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(0);
  expect(deps.check).toHaveBeenCalledTimes(2);
});

test("does not overlap checks", async () => {
  const deps = fakeDeps(() => new Promise(() => {}));
  stop = startUpdateChecks(deps);
  await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
  expect(deps.check).toHaveBeenCalledTimes(1);
});

test("swallows and logs check errors", async () => {
  const deps = fakeDeps(async () => {
    throw new Error("offline");
  });
  stop = startUpdateChecks(deps);
  await vi.advanceTimersByTimeAsync(0);
  expect(deps.report).toHaveBeenCalledWith("check_failed", undefined, new Error("offline"));
  expect(useUpdateStore.getState().available).toBeNull();
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  expect(deps.check).toHaveBeenCalledTimes(2);
});

test("apply installs then relaunches, once", async () => {
  const order: string[] = [];
  const update = fakeUpdate(async () => {
    order.push("install");
  });
  const deps = fakeDeps(async () => update);
  deps.relaunch.mockImplementation(async () => {
    order.push("relaunch");
  });
  stop = startUpdateChecks(deps);
  await vi.advanceTimersByTimeAsync(0);

  const { apply } = useUpdateStore.getState();
  await Promise.all([apply(), apply()]);

  expect(update.install).toHaveBeenCalledTimes(1);
  expect(deps.relaunch).toHaveBeenCalledTimes(1);
  expect(order).toEqual(["install", "relaunch"]);
  expect(deps.report.mock.calls).toEqual([
    ["available", "0.2.0"],
    ["installing", "0.2.0"],
    ["installed", "0.2.0"],
  ]);
});

test("reports an up-to-date check", async () => {
  const deps = fakeDeps(async () => null);
  stop = startUpdateChecks(deps);
  await vi.advanceTimersByTimeAsync(0);
  expect(deps.report).toHaveBeenCalledWith("up_to_date");
});

test("apply saves open drafts first, and installs nothing when one can't be saved", async () => {
  const order: string[] = [];
  const update = fakeUpdate(async () => {
    order.push("install");
  });
  const deps = {
    ...fakeDeps(async () => update),
    saveDrafts: vi.fn(async () => {
      order.push("save");
      return false;
    }),
  };
  stop = startUpdateChecks(deps);
  await vi.advanceTimersByTimeAsync(0);

  await useUpdateStore.getState().apply();
  expect(order).toEqual(["save"]);
  expect(deps.relaunch).not.toHaveBeenCalled();
  expect(useUpdateStore.getState()).toMatchObject({ applying: false, available: "0.2.0" });
  expect(useToastStore.getState().toasts.map((t) => t.title)).toContain("Update not installed");

  // Once the draft saves, the update goes ahead: save, then install, then relaunch.
  deps.saveDrafts.mockImplementation(async () => {
    order.push("save");
    return true;
  });
  deps.relaunch.mockImplementation(async () => {
    order.push("relaunch");
  });
  await useUpdateStore.getState().apply();
  expect(order).toEqual(["save", "save", "install", "relaunch"]);
});

test("apply failure keeps the banner", async () => {
  const deps = fakeDeps(async () =>
    fakeUpdate(async () => {
      throw new Error("download failed");
    }),
  );
  stop = startUpdateChecks(deps);
  await vi.advanceTimersByTimeAsync(0);

  await useUpdateStore.getState().apply();

  expect(deps.report.mock.calls).toEqual([
    ["available", "0.2.0"],
    ["installing", "0.2.0"],
    ["install_failed", "0.2.0", new Error("download failed")],
  ]);
  expect(deps.relaunch).not.toHaveBeenCalled();
  expect(useUpdateStore.getState().applying).toBe(false);
  expect(useUpdateStore.getState().available).toBe("0.2.0");
});

test("stop() cancels the interval", async () => {
  const deps = fakeDeps(async () => null);
  stop = startUpdateChecks(deps);
  await vi.advanceTimersByTimeAsync(0);
  stop();
  await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
  window.dispatchEvent(new Event("focus"));
  window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(0);
  expect(deps.check).toHaveBeenCalledTimes(1);
});

test("default deps adapt the tauri plugins: download once in the background, then install", async () => {
  const order: string[] = [];
  const download = vi.fn(async () => {
    order.push("download");
  });
  const install = vi.fn(async () => {
    order.push("install");
  });
  vi.mocked(relaunch).mockImplementation(async () => {
    order.push("relaunch");
  });
  const update = { version: "0.3.0", download, install, close: vi.fn(async () => {}) };
  vi.mocked(check)
    .mockResolvedValueOnce(update as never)
    .mockResolvedValueOnce(update as never);
  stop = startUpdateChecks();
  await vi.advanceTimersByTimeAsync(0);
  expect(check).toHaveBeenCalledWith({ timeout: 60 * 1000 });
  expect(useUpdateStore.getState().available).toBe("0.3.0");
  expect(order).toEqual(["download"]);

  await useUpdateStore.getState().apply();
  expect(order).toEqual(["download", "install", "relaunch"]);
  expect(install).toHaveBeenCalledWith(undefined);
});

test("default deps write updater steps to the diagnostics log", async () => {
  const logged: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "log_update") logged.push(args);
  });
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(check).mockRejectedValueOnce(new Error("offline"));
  stop = startUpdateChecks();
  await vi.advanceTimersByTimeAsync(0);
  quiet.mockRestore();
  expect(logged).toEqual([{ event: "check_failed", version: null, error: "offline" }]);
});

test("default deps leave the store empty when no update exists", async () => {
  vi.mocked(check).mockResolvedValueOnce(null);
  stop = startUpdateChecks();
  await vi.advanceTimersByTimeAsync(0);
  expect(useUpdateStore.getState().available).toBeNull();
});

test.each([
  ["0.2.0", "0.2"],
  ["1.0.0", "1.0"],
  ["0.2.1", "0.2.1"],
  ["0.2", "0.2"],
])("displayVersion(%s) is %s", (input, expected) => {
  expect(displayVersion(input)).toBe(expected);
});

describe("manual check", () => {
  test("reports checking, then up to date", async () => {
    let resolve!: (u: PendingUpdate | null) => void;
    stop = startUpdateChecks(fakeDeps(() => new Promise((r) => (resolve = r))));
    const done = checkForUpdatesNow();
    expect(useUpdateStore.getState().manualCheck).toBe("checking");
    resolve(null);
    await done;
    expect(useUpdateStore.getState().manualCheck).toBe("current");
  });

  test("shares an in-flight background check instead of starting another", async () => {
    let resolve!: (u: PendingUpdate | null) => void;
    const deps = fakeDeps(() => new Promise((r) => (resolve = r)));
    stop = startUpdateChecks(deps);
    await vi.advanceTimersByTimeAsync(0);
    const done = checkForUpdatesNow();
    resolve(fakeUpdate());
    await done;
    expect(deps.check).toHaveBeenCalledTimes(1);
    expect(useUpdateStore.getState()).toMatchObject({ available: "0.2.0", manualCheck: "idle" });
  });

  test("reports a failed check", async () => {
    const deps = fakeDeps(async () => {
      throw new Error("offline");
    });
    stop = startUpdateChecks(deps, CHECK_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);
    await checkForUpdatesNow();
    expect(useUpdateStore.getState().manualCheck).toBe("failed");
    expect(deps.check).toHaveBeenCalledTimes(2);
  });

  test("does nothing when an update is already waiting", async () => {
    const deps = fakeDeps(async () => fakeUpdate());
    stop = startUpdateChecks(deps);
    await vi.advanceTimersByTimeAsync(0);
    await checkForUpdatesNow();
    expect(deps.check).toHaveBeenCalledTimes(1);
    expect(useUpdateStore.getState().manualCheck).toBe("idle");
  });

  test("dismiss clears the result", async () => {
    stop = startUpdateChecks(fakeDeps(async () => null));
    await checkForUpdatesNow();
    useUpdateStore.getState().dismissManualCheck();
    expect(useUpdateStore.getState().manualCheck).toBe("idle");
  });

  test("the app menu event triggers a check", async () => {
    mockIPC(() => {}, { shouldMockEvents: true });
    const deps = fakeDeps(async () => null);
    stop = startUpdateChecks(deps);
    await vi.advanceTimersByTimeAsync(0);
    const unlisten = listenForManualChecks();
    await vi.advanceTimersByTimeAsync(0);
    await emit(CHECK_FOR_UPDATES_EVENT);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.check).toHaveBeenCalledTimes(2);
    expect(useUpdateStore.getState().manualCheck).toBe("current");
    unlisten();
    await vi.advanceTimersByTimeAsync(0);
    clearMocks();
  });
});

describe("automatic updates", () => {
  interface Win {
    visible: boolean;
    focused: boolean;
  }

  function autoDeps(update: PendingUpdate, win: Win = { visible: false, focused: false }) {
    const order: string[] = [];
    const deps = {
      ...fakeDeps(async () => update),
      windowState: vi.fn(async () => ({ ...win })),
      busy: vi.fn(() => false),
      startHidden: vi.fn(async () => {
        order.push("startHidden");
      }),
      saveDrafts: vi.fn(async () => true),
    };
    deps.relaunch.mockImplementation(async () => {
      order.push("relaunch");
    });
    return { deps, order, win };
  }

  function downloadable(version = "0.2.0", download: () => Promise<void> = async () => {}) {
    const order: string[] = [];
    const update = {
      ...fakeUpdate(async () => {
        order.push("install");
      }, version),
      download: vi.fn(download),
    };
    return { update, order };
  }

  test("downloads in the background and offers the update only once it's downloaded", async () => {
    let finish!: () => void;
    const { update } = downloadable("0.2.0", () => new Promise<void>((r) => (finish = r)));
    const deps = fakeDeps(async () => update);
    stop = startUpdateChecks(deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(update.download).toHaveBeenCalledTimes(1);
    expect(useUpdateStore.getState().available).toBeNull();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(useUpdateStore.getState().available).toBe("0.2.0");
    expect(deps.report.mock.calls).toEqual([
      ["available", "0.2.0"],
      ["downloaded", "0.2.0"],
    ]);
    // A later check finding the same release doesn't download it again.
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(update.download).toHaveBeenCalledTimes(1);
  });

  test("a failed download is retried like a failed check", async () => {
    const { update } = downloadable("0.2.0", async () => {
      throw new Error("reset");
    });
    const deps = fakeDeps(async () => update);
    stop = startUpdateChecks(deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(useUpdateStore.getState().available).toBeNull();
    expect(deps.report).toHaveBeenCalledWith("download_failed", "0.2.0", new Error("reset"));
    update.download.mockImplementation(async () => {});
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(useUpdateStore.getState().available).toBe("0.2.0");
  });

  test("checks every 30 minutes", () => {
    expect(CHECK_INTERVAL_MS).toBe(30 * 60 * 1000);
  });

  test("restarts into the update, hidden, once the window has been hidden for 10 minutes", async () => {
    const { update, order: installs } = downloadable();
    const { deps, order } = autoDeps(update);
    stop = startUpdateChecks(deps);
    await vi.advanceTimersByTimeAsync(IDLE_HIDDEN_MS - 60 * 1000);
    expect(update.install).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(update.install).toHaveBeenCalledTimes(1);
    expect(installs).toEqual(["install"]);
    expect(order).toEqual(["startHidden", "relaunch"]);
    expect(deps.saveDrafts).toHaveBeenCalled();
    expect(deps.report.mock.calls).toEqual([
      ["available", "0.2.0"],
      ["downloaded", "0.2.0"],
      ["auto_restart", "0.2.0"],
      ["installing", "0.2.0"],
      ["installed", "0.2.0"],
    ]);
  });

  test("restarts, shown, after an hour with the window open behind others", async () => {
    const { update } = downloadable();
    const { deps, order } = autoDeps(update, { visible: true, focused: false });
    stop = startUpdateChecks(deps);
    await vi.advanceTimersByTimeAsync(IDLE_HIDDEN_MS);
    expect(update.install).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(IDLE_UNFOCUSED_MS - IDLE_HIDDEN_MS);
    expect(update.install).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["relaunch"]);
  });

  test("never restarts while the window is in front", async () => {
    const { update } = downloadable();
    const { deps } = autoDeps(update, { visible: true, focused: true });
    stop = startUpdateChecks(deps);
    await vi.advanceTimersByTimeAsync(IDLE_UNFOCUSED_MS * 3);
    expect(update.install).not.toHaveBeenCalled();
  });

  test("using the window starts the wait over", async () => {
    const { update } = downloadable();
    const { deps, win } = autoDeps(update);
    stop = startUpdateChecks(deps);
    await vi.advanceTimersByTimeAsync(IDLE_HIDDEN_MS - 2 * 60 * 1000);
    Object.assign(win, { visible: true, focused: true });
    await vi.advanceTimersByTimeAsync(60 * 1000);
    Object.assign(win, { visible: false, focused: false });
    // Seen hidden again at the next tick; 10 minutes from then.
    await vi.advanceTimersByTimeAsync(IDLE_HIDDEN_MS);
    expect(update.install).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(update.install).toHaveBeenCalledTimes(1);
  });

  test("time asleep doesn't count for a window left open", async () => {
    const { update } = downloadable();
    const { deps } = autoDeps(update, { visible: true, focused: false });
    stop = startUpdateChecks(deps);
    await vi.advanceTimersByTimeAsync(60 * 1000);
    sleepFor(IDLE_UNFOCUSED_MS * 8);
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(update.install).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(IDLE_UNFOCUSED_MS);
    expect(update.install).toHaveBeenCalledTimes(1);
  });

  test("waits while something is open, then goes ahead", async () => {
    const { update } = downloadable();
    const { deps } = autoDeps(update);
    deps.busy.mockReturnValue(true);
    stop = startUpdateChecks(deps);
    await vi.advanceTimersByTimeAsync(IDLE_HIDDEN_MS * 3);
    expect(update.install).not.toHaveBeenCalled();
    deps.busy.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(update.install).toHaveBeenCalledTimes(1);
  });

  test("a draft that can't be saved stops the restart quietly", async () => {
    const { update } = downloadable();
    const { deps } = autoDeps(update);
    deps.saveDrafts.mockResolvedValue(false);
    stop = startUpdateChecks(deps);
    await vi.advanceTimersByTimeAsync(IDLE_HIDDEN_MS);
    expect(update.install).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(useUpdateStore.getState().applying).toBe(false);
  });

  test("does nothing unasked when automatic updates are off", async () => {
    const { update } = downloadable();
    const { deps } = autoDeps(update);
    useUpdateStore.getState().setAuto(false);
    expect(localStorage.getItem(AUTO_UPDATE_KEY)).toBe("0");
    stop = startUpdateChecks(deps);
    await vi.advanceTimersByTimeAsync(IDLE_HIDDEN_MS * 3);
    expect(update.download).toHaveBeenCalled();
    expect(update.install).not.toHaveBeenCalled();
    await installBeforeQuit();
    expect(update.install).not.toHaveBeenCalled();
    useUpdateStore.getState().setAuto(true);
    expect(localStorage.getItem(AUTO_UPDATE_KEY)).toBe("1");
  });

  test("an automatic install that fails isn't retried until a newer release", async () => {
    const { update } = downloadable();
    update.install.mockRejectedValue(new Error("disk full"));
    const { deps } = autoDeps(update);
    stop = startUpdateChecks(deps);
    await vi.advanceTimersByTimeAsync(IDLE_HIDDEN_MS);
    expect(update.install).toHaveBeenCalledTimes(1);
    expect(deps.report).toHaveBeenCalledWith("install_failed", "0.2.0", new Error("disk full"));
    await vi.advanceTimersByTimeAsync(IDLE_HIDDEN_MS * 3);
    expect(update.install).toHaveBeenCalledTimes(1);
    expect(useUpdateStore.getState()).toMatchObject({ applying: false, available: "0.2.0" });

    const { update: newer } = downloadable("0.3.0");
    deps.check.mockImplementation(async () => newer);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(newer.install).toHaveBeenCalledTimes(1);
  });

  test("quitting installs the downloaded update without starting the app again", async () => {
    const { update } = downloadable();
    const deps = fakeDeps(async () => update);
    stop = startUpdateChecks(deps);
    await vi.advanceTimersByTimeAsync(0);
    await installBeforeQuit();
    expect(update.install).toHaveBeenCalledWith({ restart: false });
    expect(deps.relaunch).not.toHaveBeenCalled();
  });

  test("a visit between ticks starts the wait over", async () => {
    const { update } = downloadable();
    const { deps } = autoDeps(update);
    stop = startUpdateChecks(deps);
    await vi.advanceTimersByTimeAsync(IDLE_HIDDEN_MS - 60 * 1000 - 1);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(1);
    expect(update.install).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(IDLE_HIDDEN_MS - 60 * 1000);
    expect(update.install).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(update.install).toHaveBeenCalledTimes(1);
  });

  test("a replacement still downloading takes the banner down", async () => {
    const { update: first } = downloadable("0.2.0");
    const deps = fakeDeps(async () => first);
    stop = startUpdateChecks(deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(useUpdateStore.getState().available).toBe("0.2.0");
    const { update: newer } = downloadable("0.3.0", async () => {
      throw new Error("reset");
    });
    deps.check.mockImplementation(async () => newer);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(useUpdateStore.getState().available).toBeNull();
  });

  test("an install on quit holds off the idle restart, and isn't retried after failing", async () => {
    let fail!: (err: Error) => void;
    const { update } = downloadable();
    update.install.mockImplementation(() => new Promise<void>((_, reject) => (fail = reject)));
    const { deps } = autoDeps(update);
    stop = startUpdateChecks(deps);
    await vi.advanceTimersByTimeAsync(0);
    const quitting = installBeforeQuit();
    await vi.advanceTimersByTimeAsync(IDLE_HIDDEN_MS * 2);
    expect(update.install).toHaveBeenCalledTimes(1);
    expect(deps.relaunch).not.toHaveBeenCalled();
    fail(new Error("disk full"));
    await quitting;
    await installBeforeQuit();
    expect(update.install).toHaveBeenCalledTimes(1);
  });

  test("quitting installs nothing before the download finishes", async () => {
    const { update } = downloadable("0.2.0", () => new Promise<void>(() => {}));
    stop = startUpdateChecks(fakeDeps(async () => update));
    await vi.advanceTimersByTimeAsync(0);
    await installBeforeQuit();
    expect(update.install).not.toHaveBeenCalled();
  });
});
