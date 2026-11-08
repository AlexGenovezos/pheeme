import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { registry } from "../../keyboard/registry";
import type { AttachmentInfo } from "../../lib/tauri";
import { AttachmentPreview } from "./AttachmentPreview";
import { clearAttachmentBytes } from "./bytes";
import { usePreviewStore } from "./previewStore";

const file = (
  id: string,
  filename: string,
  mimeType = "application/octet-stream",
): AttachmentInfo => ({
  id,
  filename,
  mimeType,
  size: 2048,
  isInline: false,
  contentId: null,
});

/** `src/preview/files/sample.xlsx` (two sheets: Budget, Volunteers), base64-encoded. */
const SAMPLE_XLSX =
  "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";
const sampleXlsx = () => Uint8Array.from(atob(SAMPLE_XLSX), (c) => c.charCodeAt(0)).buffer;

let reads: string[] = [];
let opened: string[] = [];

beforeEach(() => {
  clearAttachmentBytes();
  reads = [];
  opened = [];
  usePreviewStore.setState({ session: null });
  mockIPC((cmd, args) => {
    const a = args as Record<string, string>;
    if (cmd === "read_attachment") {
      reads.push(a.attachmentId);
      if (a.attachmentId === "csv")
        return new TextEncoder().encode("Item,Cost\nHall,1200\n").buffer;
      if (a.attachmentId === "xlsx") return sampleXlsx();
      if (a.attachmentId === "txt") return new TextEncoder().encode("plain words").buffer;
      throw { code: "network", message: "Gmail is unavailable." };
    }
    if (cmd === "open_attachment") opened.push(a.attachmentId);
  });
});

const open = (files: AttachmentInfo[], index = 0) =>
  act(() => usePreviewStore.getState().open({ accountId: "a1", messageId: "m1", files, index }));

const key = (k: string) => fireEvent.keyDown(document.activeElement ?? document.body, { key: k });

test("a CSV shows as a grid, and the arrows flip to the next file", async () => {
  render(<AttachmentPreview />);
  open([file("csv", "costs.csv"), file("txt", "notes.txt")]);
  expect(screen.getByRole("dialog", { name: "Preview: costs.csv" })).toBeInTheDocument();
  expect(await screen.findByRole("cell", { name: "1200" })).toHaveAttribute("data-numeric");
  expect(screen.getByText("2 KB · 1 of 2")).toBeInTheDocument();

  key("ArrowRight");
  expect(await screen.findByText("plain words")).toBeInTheDocument();
  key("ArrowRight");
  expect(await screen.findByRole("cell", { name: "Hall" })).toBeInTheDocument();
  // The neighbour was warmed while the first file showed; flipping back reads nothing new.
  expect(reads.filter((id) => id === "txt")).toHaveLength(1);
});

test("an .xlsx workbook shows its sheets as tabs", async () => {
  render(<AttachmentPreview />);
  open([file("xlsx", "budget.xlsx")]);
  expect(
    await screen.findByRole("cell", { name: "Parking signs" }, { timeout: 3000 }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: "Volunteers" }));
  expect(screen.getByRole("cell", { name: "Clean-up" })).toBeInTheDocument();
});

test("Space and Escape close it; mail shortcuts are off while it's open", () => {
  render(<AttachmentPreview />);
  let ran = 0;
  const off = registry.register({ id: "test.e", title: "t", shortcut: "e", run: () => ran++ });
  open([file("csv", "costs.csv")]);
  registry.handleKeyDown(new KeyboardEvent("keydown", { key: "e" }));
  expect(ran).toBe(0);
  key(" ");
  expect(screen.queryByRole("dialog")).toBeNull();
  open([file("csv", "costs.csv")]);
  key("Escape");
  expect(screen.queryByRole("dialog")).toBeNull();
  registry.handleKeyDown(new KeyboardEvent("keydown", { key: "e" }));
  expect(ran).toBe(1);
  off();
});

test("a file it can't show says so and offers what's possible", () => {
  render(<AttachmentPreview />);
  open([file("zip", "sources.zip", "application/zip"), file("key", "deck.key")]);
  expect(screen.getByText(/can't preview this kind of file. Download it/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
  expect(reads).toEqual([]);

  key("ArrowRight");
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(opened).toEqual(["key"]);
});

test("a failed read explains why", async () => {
  render(<AttachmentPreview />);
  open([file("broken", "plan.pdf")]);
  expect(
    await screen.findByText(/Couldn't load “plan.pdf”: Gmail is unavailable./),
  ).toBeInTheDocument();
});
