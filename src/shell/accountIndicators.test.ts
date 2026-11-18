import { expect, test } from "vitest";
import {
  ACCOUNT_INDICATORS_KEY,
  DEFAULT_ACCOUNT_INDICATORS,
  readAccountIndicators,
} from "./accountIndicators";

const stored = (value: string | null) => ({
  getItem: (key: string) => (key === ACCOUNT_INDICATORS_KEY ? value : null),
});

test("Glow is on and the rest off until changed", () => {
  expect(readAccountIndicators(stored(null))).toEqual(DEFAULT_ACCOUNT_INDICATORS);
  expect(DEFAULT_ACCOUNT_INDICATORS).toEqual({ glow: true, windowColor: false });
});

test("reads stored choices, ignoring anything malformed", () => {
  expect(
    readAccountIndicators(stored(JSON.stringify({ glow: false, rail: true, windowColor: "yes" }))),
  ).toEqual({ glow: false, windowColor: false });
  expect(readAccountIndicators(stored("not json"))).toEqual(DEFAULT_ACCOUNT_INDICATORS);
});
