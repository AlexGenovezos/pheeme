import { expect, test } from "vitest";
import {
  applyExistingLabel,
  changesExisting,
  criteriaOf,
  EMPTY_SPEC,
  formOf,
  NEW_LABEL,
  sentence,
  sizeBytes,
  sizeParts,
  specOf,
} from "./form";

test("a filter's spec opens in the form and saves back the same", () => {
  const spec = {
    ...EMPTY_SPEC,
    from: "news@x.com",
    subject: "Sale",
    size: 3 * 1024 * 1024,
    sizeComparison: "smaller" as const,
    hasAttachment: true,
    skipInbox: true,
    label: "Label_1",
    forward: "me@else.com",
    important: false,
    category: "CATEGORY_PROMOTIONS",
  };
  const form = formOf(spec);
  expect(form).toMatchObject({ size: "3", sizeUnit: "MB", applyLabel: true, neverImportant: true });
  expect(specOf(form, "Label_1")).toEqual({ spec });
});

test("sizes show in the biggest whole unit and save in bytes", () => {
  expect(sizeParts(2048)).toEqual({ size: "2", unit: "KB" });
  expect(sizeParts(1000)).toEqual({ size: "1000", unit: "bytes" });
  expect(sizeBytes({ size: "1.5", sizeUnit: "KB" })).toBe(1536);
  expect(sizeBytes({ size: " ", sizeUnit: "MB" })).toBeNull();
  expect(sizeBytes({ size: "-2", sizeUnit: "MB" })).toBeNaN();
});

test("Filter messages like these opens on the sender alone", () => {
  const form = formOf({ from: "a@x.com" });
  expect(criteriaOf(form)).toEqual({ ...EMPTY_SPEC, from: "a@x.com" });
  expect(specOf(form, null)).toEqual({
    problem: "Choose at least one thing to do with matching mail.",
  });
  expect(changesExisting(form)).toBe(false);
});

test("the form says what's missing before anything is sent", () => {
  const blank = formOf({});
  expect(criteriaOf(blank)).toBeNull();
  expect(specOf({ ...blank, star: true }, null)).toEqual({
    problem: "Fill in at least one search option.",
  });
  const sender = { ...formOf({ from: "a@x.com" }) };
  expect(specOf({ ...sender, star: true, size: "big" }, null)).toEqual({
    problem: "Type the size as a number greater than zero.",
  });
  expect(specOf({ ...sender, applyLabel: true }, null)).toEqual({
    problem: "Choose a label to apply.",
  });
  expect(specOf({ ...sender, applyLabel: true, label: NEW_LABEL }, null)).toEqual({
    problem: "Name the new label.",
  });
  expect(specOf({ ...sender, forwardOn: true }, null)).toEqual({
    problem: "Choose an address to forward to.",
  });
  // A ticked action's control left unticked doesn't count.
  const { spec } = specOf({ ...sender, star: true, label: "Label_1" }, "Label_1") as {
    spec: { label: string | null };
  };
  expect(spec.label).toBeNull();
});

test("only label changes reach existing mail; the count shows once known", () => {
  expect(changesExisting({ ...formOf({ from: "a" }), forwardOn: true, neverSpam: true })).toBe(
    false,
  );
  expect(changesExisting({ ...formOf({ from: "a" }), trash: true })).toBe(true);
  expect(applyExistingLabel(undefined)).toBe("Also apply filter to matching conversations.");
  expect(applyExistingLabel(1)).toBe("Also apply filter to 1 matching conversation.");
  expect(applyExistingLabel(12)).toBe("Also apply filter to 12 matching conversations.");
  expect(sentence(["skip the inbox (archive it)", "star it"])).toBe(
    "Skip the inbox (archive it), star it",
  );
});
