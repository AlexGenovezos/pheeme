import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  CHECK_FOR_UPDATES_EVENT,
  CHECK_INTERVAL_MS,
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

function fakeUpdate(install: PendingUpdate["install"] = async () => {}) {
  return { version: "0.2.0", install: vi.fn(install) };
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

test("stops checking once an update is available", async () => {
  const deps = fakeDeps(async () => fakeUpdate());
  stop = startUpdateChecks(deps);
  await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
  expect(deps.check).toHaveBeenCalledTimes(1);
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
  await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
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
