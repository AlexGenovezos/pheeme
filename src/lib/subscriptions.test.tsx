import { render } from "@testing-library/react";
import { useEffect } from "react";
import { expect, test, vi } from "vitest";
import { createSubscriptionScope, subscribeAll } from "./subscriptions";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("a scope releases owned listeners once, even when disposed repeatedly", async () => {
  const scope = createSubscriptionScope();
  const first = vi.fn();
  const second = vi.fn();
  await scope.add(async () => first);
  await scope.add(async () => second);
  expect(first).not.toHaveBeenCalled();
  scope.dispose();
  scope.dispose();
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
});

test("unmount releases a listener whose registration is still pending", async () => {
  const pending = deferred<() => void>();
  const stop = vi.fn();
  const log = vi.fn();
  function Listener() {
    useEffect(() => {
      const scope = createSubscriptionScope();
      scope.add(() => pending.promise).catch(log);
      return scope.dispose;
    }, []);
    return null;
  }
  const { unmount } = render(<Listener />);
  unmount();
  pending.resolve(stop);
  await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  expect(log).not.toHaveBeenCalled();
});

test("a scope leaves independent listeners active when another registration fails", async () => {
  const scope = createSubscriptionScope();
  const stop = vi.fn();
  await scope.add(async () => stop);
  const failure = new Error("bridge unavailable");
  await expect(scope.add(() => Promise.reject(failure))).rejects.toBe(failure);
  expect(stop).not.toHaveBeenCalled();
  scope.dispose();
  expect(stop).toHaveBeenCalledTimes(1);
});

test("cleanup failures do not escape or prevent other listeners from being released", async () => {
  const scope = createSubscriptionScope();
  const throwing = vi.fn(() => {
    throw new Error("bridge gone");
  });
  const rejecting = vi.fn(async () => {
    throw new Error("async bridge gone");
  });
  const stop = vi.fn();
  await scope.add(async () => throwing);
  await scope.add(async () => rejecting);
  await scope.add(async () => stop);
  expect(() => scope.dispose()).not.toThrow();
  scope.dispose();
  expect(throwing).toHaveBeenCalledTimes(1);
  expect(rejecting).toHaveBeenCalledTimes(1);
  expect(stop).toHaveBeenCalledTimes(1);
  // Let asynchronous cleanup rejections settle so unhandled rejections fail this test.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("a group returns cleanup for every successful registration", async () => {
  const first = vi.fn();
  const second = vi.fn();
  const stop = await subscribeAll([async () => first, async () => second]);
  expect(first).not.toHaveBeenCalled();
  stop();
  stop();
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
});

test("a failed group releases acquired listeners and any that arrive after rejection", async () => {
  const failed = deferred<() => void>();
  const late = deferred<() => void>();
  const first = vi.fn();
  const last = vi.fn();
  const failure = new Error("registration failed");
  const ready = subscribeAll([async () => first, () => failed.promise, () => late.promise]);
  const rejected = expect(ready).rejects.toBe(failure);
  failed.reject(failure);
  await rejected;
  expect(first).toHaveBeenCalledTimes(1);
  late.resolve(last);
  await vi.waitFor(() => expect(last).toHaveBeenCalledTimes(1));
  expect(first).toHaveBeenCalledTimes(1);
});

test("a synchronous setup failure still releases listeners from other registrations", async () => {
  const failure = new Error("webview unavailable");
  const stop = vi.fn();
  await expect(
    subscribeAll([
      () => {
        throw failure;
      },
      async () => stop,
    ]),
  ).rejects.toBe(failure);
  expect(stop).toHaveBeenCalledTimes(1);
});

test("a group with an already aborted owner releases every registration", async () => {
  const controller = new AbortController();
  controller.abort();
  const stop = vi.fn();
  const dispose = await subscribeAll([async () => stop], controller.signal);
  expect(stop).toHaveBeenCalledTimes(1);
  dispose();
  expect(stop).toHaveBeenCalledTimes(1);
});
