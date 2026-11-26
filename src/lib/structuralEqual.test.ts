import { describe, expect, it } from "vitest";
import { structuralEqual } from "./structuralEqual";

describe("structuralEqual", () => {
  it("compares nested data by value", () => {
    const a = { n: 1, list: [{ x: "a" }, { x: "b" }], on: { kind: "never" } };
    expect(
      structuralEqual(a, { on: { kind: "never" }, list: [{ x: "a" }, { x: "b" }], n: 1 }),
    ).toBe(true);
  });

  it("notices a changed leaf, a longer list and a different key set", () => {
    expect(structuralEqual({ list: [1, 2] }, { list: [1, 3] })).toBe(false);
    expect(structuralEqual({ list: [1] }, { list: [1, 2] })).toBe(false);
    expect(structuralEqual<object>({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(structuralEqual<object>({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });

  it("tells arrays from objects and null from objects", () => {
    expect(structuralEqual<unknown>([], {})).toBe(false);
    expect(structuralEqual<unknown>(null, {})).toBe(false);
    expect(structuralEqual(NaN, NaN)).toBe(true);
  });
});
