import { expect, test } from "vitest";
import { contrastRatio } from "../styles/themes/color";
import type { LabelInfo } from "../lib/tauri";
import { chipColors, LABEL_ALLOWED, LABEL_BACKGROUNDS, labelColor } from "./palette";

const info = (over: Partial<LabelInfo>): LabelInfo => ({
  id: "L",
  accountId: "a1",
  name: "L",
  type: "user",
  messagesTotal: 0,
  messagesUnread: 0,
  threadsTotal: 0,
  threadsUnread: 0,
  colorBackground: null,
  colorText: null,
  messageListVisibility: "show",
  labelListVisibility: "labelShow",
  ...over,
});

test("palette_matches_rust", () => {
  expect(LABEL_BACKGROUNDS).toHaveLength(64);
  expect(LABEL_BACKGROUNDS[0]).toBe("#000000");
  expect(LABEL_BACKGROUNDS[11]).toBe("#16a766");
  expect(LABEL_BACKGROUNDS).toEqual(LABEL_ALLOWED.slice(0, 64));
});

test("labelColor picks the higher-contrast text like Rust text_for", () => {
  expect(labelColor("#16a766").text).toBe("#000000");
  expect(labelColor("#000000").text).toBe("#ffffff");
  expect(labelColor("#fef1d1").text).toBe("#000000");
  expect(labelColor("#16a766").background).toBe("#16a766");
});

test("chip_colors_fix_low_contrast_pairs", () => {
  const c = chipColors(info({ colorBackground: "#16a766", colorText: "#ffffff" }))!;
  expect(c.background).toBe("#16a766");
  expect(c.color).not.toBe("#ffffff");
  expect(contrastRatio(c.color, c.background)).toBeGreaterThanOrEqual(4.5);
});

test("chipColors keeps readable pairs, derives missing text, and is null without a colour", () => {
  expect(chipColors(info({}))).toBeNull();
  const ok = chipColors(info({ colorBackground: "#000000", colorText: "#ffffff" }))!;
  expect(ok.color).toBe("#ffffff");
  const derived = chipColors(info({ colorBackground: "#fef1d1" }))!;
  expect(contrastRatio(derived.color, derived.background)).toBeGreaterThanOrEqual(4.5);
});

test("light chips get a border; saturated ones do not", () => {
  expect(chipColors(info({ colorBackground: "#ffffff", colorText: "#000000" }))!.border).toBe(true);
  expect(chipColors(info({ colorBackground: "#4a86e8", colorText: "#000000" }))!.border).toBe(
    false,
  );
});

test.each(["#3c78d8", "#8e63ce"])(
  "chip text on %s reaches 4.5:1 even when Gmail's text does not",
  (bg) => {
    const c = chipColors(info({ colorBackground: bg, colorText: "#ffffff" }))!;
    expect(contrastRatio(c.color, c.background)).toBeGreaterThanOrEqual(4.5);
  },
);

test("every allowed background gets readable text, with or without Gmail's text colour", () => {
  for (const bg of LABEL_ALLOWED) {
    for (const colorText of [null, "#ffffff", "#000000"]) {
      const c = chipColors(info({ colorBackground: bg, colorText }))!;
      expect(contrastRatio(c.color, c.background), `${bg} / ${colorText}`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  }
});
