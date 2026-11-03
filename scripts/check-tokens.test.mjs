// @vitest-environment node
import { describe, expect, it } from "vitest";
import { checkTokens, findRawValues } from "./check-tokens.mjs";

describe("check-tokens", () => {
  it("flags raw colors, lengths and durations", () => {
    expect(
      findRawValues(".x { color: #fff; padding: 4px; transition: opacity 120ms; width: .5rem; background: rgb(0 0 0); }"),
    ).toEqual(["hex color #fff", "color function rgb(", "length/duration 4px", "length/duration 120ms", "length/duration .5rem"]);
  });

  it("flags negative lengths but not digits inside token names", () => {
    expect(findRawValues(".x { margin-left: -12px; gap: var(--space-4px); top: calc(-1 * var(--space-2)); }")).toEqual([
      "length/duration 12px",
    ]);
  });

  it("allows tokens, zero, unitless numbers, percentages and comments", () => {
    expect(
      findRawValues(
        "/* 12px #abc */ .x { margin: 0; transition: visibility 0s; opacity: 0.8; left: 50%; flex: 1; padding: var(--space-2); grid-template-columns: 1fr; }",
      ),
    ).toEqual([]);
  });

  it("every stylesheet under src/ uses tokens only", () => {
    expect(checkTokens()).toEqual([]);
  });
});
