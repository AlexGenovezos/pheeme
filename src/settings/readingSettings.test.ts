import { beforeEach, expect, test } from "vitest";
import { initReadingSize, READING_SIZE_KEY, useReadingSettings } from "./readingSettings";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-reading-size");
  initReadingSize();
});

test("a larger reading choice survives a new initialization", () => {
  useReadingSettings.getState().setSize("large");
  expect(localStorage.getItem(READING_SIZE_KEY)).toBe("large");
  expect(document.documentElement.dataset.readingSize).toBe("large");
  useReadingSettings.setState({ size: "standard" });
  initReadingSize();
  expect(useReadingSettings.getState().size).toBe("large");
  expect(document.documentElement.dataset.readingSize).toBe("large");
});

test("a missing or invalid stored choice restores standard reading text", () => {
  expect(useReadingSettings.getState().size).toBe("standard");
  useReadingSettings.getState().setSize("large");
  localStorage.setItem(READING_SIZE_KEY, "enormous");
  initReadingSize();
  expect(useReadingSettings.getState().size).toBe("standard");
  expect(document.documentElement.dataset.readingSize).toBe("standard");
});
