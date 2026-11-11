import { expect, test } from "vitest";
import { slideDirection } from "./slide";

test("later dates slide in from the right, earlier from the left", () => {
  expect(slideDirection("2026-11-08", "2026-11-15")).toBe(1);
  expect(slideDirection("2026-11-08", "2026-11-01")).toBe(-1);
  expect(slideDirection("2026-11-08", "2026-11-08")).toBe(0);
});
