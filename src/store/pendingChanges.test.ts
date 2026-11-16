// @vitest-environment node
import { expect, test } from "vitest";
import { PendingChanges } from "./pendingChanges";

const appendAll = (pending: PendingChanges<string, string>, key: string) =>
  pending.apply(key, "", (out, change) => out + change);

test("changes apply over loaded data per key, in the order they were made", () => {
  const pending = new PendingChanges<string, string>();
  expect(pending.isEmpty).toBe(true);
  pending.add(["a", "b"], 1, "x");
  pending.add(["a"], 2, "y");
  expect(pending.isEmpty).toBe(false);
  expect(appendAll(pending, "a")).toBe("xy");
  expect(appendAll(pending, "b")).toBe("x");
  // A key with nothing waiting comes back as loaded.
  expect(pending.apply("c", "loaded", () => "changed")).toBe("loaded");
});

test("settling an op releases its changes and keeps the others", () => {
  const pending = new PendingChanges<string, string>();
  pending.add(["a", "b"], 1, "x");
  pending.add(["a"], 2, "y");
  pending.add(["a"], 1, "z");
  expect(pending.settle(1)).toEqual([
    ["a", "x"],
    ["a", "z"],
    ["b", "x"],
  ]);
  expect(appendAll(pending, "a")).toBe("y");
  expect(appendAll(pending, "b")).toBe("");
  expect(pending.settle(2)).toEqual([["a", "y"]]);
  expect(pending.isEmpty).toBe(true);
});

test("settling an op for some keys leaves its changes to the rest waiting", () => {
  const pending = new PendingChanges<string, string>();
  pending.add(["a", "b"], 1, "x");
  expect(pending.settle(1, ["b", "missing"])).toEqual([["b", "x"]]);
  expect(appendAll(pending, "a")).toBe("x");
  expect(appendAll(pending, "b")).toBe("");
  expect(pending.settle(1, ["a"])).toEqual([["a", "x"]]);
  expect(pending.isEmpty).toBe(true);
});

test("settling an unknown op changes nothing", () => {
  const pending = new PendingChanges<string, string>();
  pending.add(["a"], 1, "x");
  expect(pending.settle(9)).toEqual([]);
  expect(appendAll(pending, "a")).toBe("x");
});

test("clear forgets every change", () => {
  const pending = new PendingChanges<string, string>();
  pending.add(["a", "b"], 1, "x");
  pending.clear();
  expect(pending.isEmpty).toBe(true);
  expect(appendAll(pending, "a")).toBe("");
});
