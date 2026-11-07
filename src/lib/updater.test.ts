import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  CHECK_FOR_UPDATES_EVENT,
  CHECK_INTERVAL_MS,
  RETRY_MS,
  __resetForTests,
  checkForUpdatesNow,
  displayVersion,
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
  deps.check.mockImplementation(async () => fakeUpdate(undefined, "0.3.0"));
  await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
  expect(deps.check).toHaveBeenCalledTimes(1);
  finish();
  await applying;
  expect(useUpdateStore.getState().available).toBe("0.2.0");
});

test("a check that finishes during an install leaves the update alone", async () => {
  let resolve!: (u: PendingUpdate | null) => void;
  const deps = fakeDeps(async () => fakeUpdate(() => new Promise<void>(() => {})));
  stop = startUpdateChecks(deps);
  await vi.advanceTimersByTimeAsync(0);
  deps.check.mockImplementation(() => new Promise((r) => (resolve = r)));
  await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
  void useUpdateStore.getState().apply();
  const late = fakeUpdate(undefined, "0.3.0");
  resolve(late);
  await vi.advanceTimersByTimeAsync(0);
  expect(useUpdateStore.getState().available).toBe("0.2.0");
  expect(late.close).toHaveBeenCalled();
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

test("default deps adapt the tauri plugins", async () => {
  const order: string[] = [];
  const downloadAndInstall = vi.fn(async () => {
    order.push("install");
  });
  vi.mocked(relaunch).mockImplementation(async () => {
    order.push("relaunch");
  });
  vi.mocked(check).mockResolvedValueOnce({ version: "0.3.0", downloadAndInstall } as never);
  stop = startUpdateChecks();
  await vi.advanceTimersByTimeAsync(0);
  expect(check).toHaveBeenCalledWith({ timeout: 60 * 1000 });
  expect(useUpdateStore.getState().available).toBe("0.3.0");

  await useUpdateStore.getState().apply();
  expect(order).toEqual(["install", "relaunch"]);
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
