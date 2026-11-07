import { expect, test } from "vitest";
import { canOpenExternally, extension, previewKind } from "./kinds";

test("the extension decides first, since senders often send octet-stream", () => {
  expect(previewKind("Meeting 31Aug24.PDF", "application/octet-stream")).toBe("pdf");
  expect(previewKind("notes.docx", null)).toBe("docx");
  expect(previewKind("budget.xlsx", null)).toBe("xlsx");
  expect(previewKind("list.tsv", null)).toBe("csv");
  expect(previewKind("photo.JPG", null)).toBe("image");
  expect(previewKind("readme.md", null)).toBe("text");
});

test("without a known extension, the MIME type decides", () => {
  expect(previewKind("scan", "image/png; name=scan")).toBe("image");
  expect(previewKind(null, "application/pdf")).toBe("pdf");
  expect(previewKind("page.html", "text/html")).toBe("other");
});

test("a known extension that can't be previewed isn't overridden by its MIME type", () => {
  expect(previewKind("slides.pptx", "application/pdf")).toBe("other");
  expect(previewKind("old.doc", "text/plain")).toBe("other");
});

test("only documents and media open in the default app", () => {
  expect(canOpenExternally("a.pdf")).toBe(true);
  expect(canOpenExternally("deck.KEY")).toBe(true);
  for (const name of ["setup.exe", "run.command", "a.zip", "page.html", "image.svg", "x", null])
    expect(canOpenExternally(name)).toBe(false);
});

test("extension", () => {
  expect(extension("a.tar.gz")).toBe("gz");
  expect(extension(".bashrc")).toBeNull();
  expect(extension("dir.d/notes")).toBeNull();
  expect(extension("trailing.")).toBeNull();
});
