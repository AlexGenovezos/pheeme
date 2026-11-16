import { describe, expect, test } from "vitest";
import { readItem, readJson, writeItem, writeJson } from "./storage";

const throwing = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("quota");
  },
};

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe("storage", () => {
  test("reads what was written, as text and as JSON", () => {
    const store = memory();
    writeItem("a", "text", store);
    writeJson("b", { n: 1 }, store);
    expect(readItem("a", store)).toBe("text");
    expect(readJson("b", store)).toEqual({ n: 1 });
  });

  test("a missing or unparsable value reads as nothing", () => {
    const store = memory({ bad: "{oops", nothing: "null" });
    expect(readItem("missing", store)).toBeNull();
    expect(readJson("missing", store)).toBeUndefined();
    expect(readJson("bad", store)).toBeUndefined();
    expect(readJson("nothing", store)).toBeUndefined();
  });

  test("blocked or full storage neither reads nor throws", () => {
    expect(readItem("a", throwing)).toBeNull();
    expect(readJson("a", throwing)).toBeUndefined();
    expect(() => writeItem("a", "x", throwing)).not.toThrow();
    expect(() => writeJson("a", {}, throwing)).not.toThrow();
  });

  test("no storage at all is the same as empty storage", () => {
    expect(readItem("a", undefined)).toBeNull();
    expect(() => writeItem("a", "x", undefined)).not.toThrow();
  });
});
