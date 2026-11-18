import { expect, test } from "vitest";
import { pastedFiles } from "./paste";

const clipboard = (files: File[], text = "", html = "") =>
  ({
    files,
    getData: (type: string) => (type === "text/plain" ? text : type === "text/html" ? html : ""),
  }) as unknown as DataTransfer;

const png = new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });

test("a screenshot on the clipboard is a file to attach", () => {
  expect(pastedFiles(clipboard([png]))).toEqual([png]);
  expect(pastedFiles(clipboard([png], "", '<img src="https://x/y.png">'))).toEqual([png]);
});

test("text stays text, even with a picture of it beside it", () => {
  expect(pastedFiles(clipboard([png], "Quarterly numbers"))).toEqual([]);
  expect(pastedFiles(clipboard([], "hello"))).toEqual([]);
  expect(pastedFiles(null)).toEqual([]);
});
