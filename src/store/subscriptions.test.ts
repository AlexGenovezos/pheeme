import { listen } from "@tauri-apps/api/event";
import { beforeEach, expect, test, vi } from "vitest";
import { createSubscriptionScope } from "../lib/subscriptions";
import { useAccountStore } from "./accountStore";
import { useLabelStore } from "./labelStore";
import { useMailStore } from "./mailStore";
import { useThreadStore } from "./threadStore";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const stores = [
  ["account", (signal?: AbortSignal) => useAccountStore.getState().subscribe(signal)],
  ["label", (signal?: AbortSignal) => useLabelStore.getState().subscribe(signal)],
  ["mail", (signal?: AbortSignal) => useMailStore.getState().subscribe(signal)],
  ["thread", (signal?: AbortSignal) => useThreadStore.getState().subscribe(signal)],
] as const;

beforeEach(() => {
  vi.mocked(listen).mockReset();
});

test.each(stores)(
  "%s subscriptions clean up partial setup on failure",
  async (_name, subscribe) => {
    const stops: ReturnType<typeof vi.fn>[] = [];
    const failure = new Error("listener registration failed");
    vi.mocked(listen).mockImplementation(() => {
      if (stops.length === 1) return Promise.reject(failure);
      const stop = vi.fn();
      stops.push(stop);
      return Promise.resolve(stop);
    });
    await expect(subscribe()).rejects.toBe(failure);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveBeenCalledTimes(1);
  },
);

test.each(stores)(
  "%s subscriptions release partial setup immediately when their owner is disposed",
  async (_name, subscribe) => {
    let finish!: (stop: () => void) => void;
    const late = new Promise<() => void>((resolve) => {
      finish = resolve;
    });
    const first = vi.fn();
    const last = vi.fn();
    const extra = vi.fn();
    vi.mocked(listen)
      .mockResolvedValue(extra)
      .mockResolvedValueOnce(first)
      .mockReturnValueOnce(late);
    const scope = createSubscriptionScope();
    const ready = scope.add((signal) => subscribe(signal));
    await Promise.resolve();
    expect(first).not.toHaveBeenCalled();
    scope.dispose();
    // The group is not ready yet: cleanup must not wait for its slow registration.
    expect(first).toHaveBeenCalledTimes(1);
    finish(last);
    await ready;
    expect(last).toHaveBeenCalledTimes(1);
    scope.dispose();
    expect(first).toHaveBeenCalledTimes(1);
  },
);

test.each(stores)(
  "%s subscriptions release registrations that arrive after failure",
  async (_name, subscribe) => {
    let finish!: (stop: () => void) => void;
    const late = new Promise<() => void>((resolve) => {
      finish = resolve;
    });
    const failure = new Error("listener registration failed");
    const stop = vi.fn();
    vi.mocked(listen)
      .mockRejectedValue(failure)
      .mockRejectedValueOnce(failure)
      .mockReturnValueOnce(late);
    await expect(subscribe()).rejects.toBe(failure);
    finish(stop);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  },
);
