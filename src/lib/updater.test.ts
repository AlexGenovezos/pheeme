import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  CHECK_INTERVAL_MS,
  __resetForTests,
  startUpdateChecks,
  useUpdateStore,
  type PendingUpdate,
  type UpdaterDeps,
} from "./updater";

let stop: () => void = () => {};

function fakeDeps(check: UpdaterDeps["check"]) {
  return { check: vi.fn(check), relaunch: vi.fn(async () => {}), log: vi.fn() };
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
  expect(deps.log).toHaveBeenCalledTimes(1);
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

  expect(deps.log).toHaveBeenCalledTimes(1);
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
