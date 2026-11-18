import { expect, test } from "vitest";
import { coalesce } from "./coalesce";

/** A run the test finishes by hand. */
function deferredRuns() {
  const calls: { arg: number; finish: (fail?: boolean) => void }[] = [];
  const run = (arg: number) =>
    new Promise<void>((resolve, reject) => {
      calls.push({ arg, finish: (fail) => (fail ? reject(new Error("no")) : resolve()) });
    });
  return { calls, run };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test("calls during a run share one follow-up with the latest arguments", async () => {
  const { calls, run } = deferredRuns();
  const load = coalesce(run);
  const first = load(1);
  const second = load(2);
  const third = load(3);
  expect(calls.map((c) => c.arg)).toEqual([1]);
  expect(second).toBe(third);

  let followUpDone = false;
  void third.then(() => (followUpDone = true));
  calls[0].finish();
  await first;
  await flush();
  expect(calls.map((c) => c.arg)).toEqual([1, 3]);
  expect(followUpDone).toBe(false);

  calls[1].finish();
  await third;
  expect(followUpDone).toBe(true);
});

test("runs at once when idle, and again after a run finishes", async () => {
  const { calls, run } = deferredRuns();
  const load = coalesce(run);
  const first = load(1);
  calls[0].finish();
  await first;
  await flush();
  void load(2);
  expect(calls.map((c) => c.arg)).toEqual([1, 2]);
});

test("a failed run still starts the follow-up, and the failure reaches only its own caller", async () => {
  const { calls, run } = deferredRuns();
  const load = coalesce(run);
  const first = load(1);
  const second = load(2);
  calls[0].finish(true);
  await expect(first).rejects.toThrow("no");
  await flush();
  expect(calls.map((c) => c.arg)).toEqual([1, 2]);
  calls[1].finish();
  await expect(second).resolves.toBeUndefined();
});
