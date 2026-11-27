import type { Editor as TipTap } from "@tiptap/react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, test } from "vitest";
import { EditorBody, EditorToolbar, useComposeEditor } from "./Editor";

let html = "";
let current: TipTap | null = null;
function Harness({ initial }: { initial: string }) {
  const editor = useComposeEditor(initial, (h) => (html = h));
  // The tests set the selection on the same editor the bar drives.
  useEffect(() => {
    current = editor;
  }, [editor]);
  return (
    <>
      <EditorBody editor={editor} focusSeq={0} />
      <EditorToolbar editor={editor} />
    </>
  );
}

const editor = () => {
  if (!current) throw new Error("no editor");
  return current;
};

function setup(initial = "<p>Hello</p>") {
  html = "";
  render(<Harness initial={initial} />);
  act(() => void editor().commands.selectAll());
  return screen.getByRole("toolbar", { name: "Formatting" });
}

/** Open the bar's menu `name` and choose `item`. */
function choose(bar: HTMLElement, name: string, item: string) {
  fireEvent.click(within(bar).getByRole("button", { name }));
  const menu = screen.getByRole("menu", { name: name === "More formatting options" ? name : name });
  fireEvent.click(within(menu).getByText(item));
}

afterEach(() => {
  html = "";
});

test("font, size, colours and alignment come out as Gmail writes them", () => {
  const bar = setup();
  choose(bar, "Font", "Georgia");
  expect(within(bar).getByRole("button", { name: "Font" })).toHaveTextContent("Georgia");
  choose(bar, "Size", "Large");
  act(() => void editor().commands.selectAll());

  fireEvent.click(within(bar).getByRole("button", { name: "Text colour" }));
  const colours = screen.getByRole("dialog", { name: "Colour" });
  fireEvent.click(
    within(within(colours).getByRole("group", { name: "Text colour" })).getByRole("radio", {
      name: "red",
    }),
  );
  expect(screen.queryByRole("dialog", { name: "Colour" })).toBeNull();

  fireEvent.click(within(bar).getByRole("button", { name: "Text colour" }));
  const again = screen.getByRole("dialog", { name: "Colour" });
  // The selection's colour is ticked.
  expect(
    within(within(again).getByRole("group", { name: "Text colour" })).getByRole("radio", {
      name: "red",
    }),
  ).toBeChecked();
  fireEvent.click(
    within(within(again).getByRole("group", { name: "Background colour" })).getByRole("radio", {
      name: "yellow",
    }),
  );

  choose(bar, "Align", "Align centre");

  expect(html).toContain('<font face="georgia, serif">');
  expect(html).toContain('<font size="4">');
  expect(html).toContain('<font color="#ff0000">');
  expect(html).toMatch(/background-color/);
  expect(html).toMatch(/text-align: ?center/);
});

test("More: quote, strikethrough, indent and remove formatting; undo and redo", () => {
  const bar = setup("<p><b>Hello</b></p>");
  choose(bar, "More formatting options", "Strikethrough");
  expect(html).toContain("<s>");
  act(() => void editor().commands.selectAll());
  choose(bar, "More formatting options", "Remove formatting");
  expect(html).toBe("<p>Hello</p>");

  choose(bar, "More formatting options", "Indent more");
  expect(html).toMatch(/margin-left: ?40px/);
  choose(bar, "More formatting options", "Indent less");
  choose(bar, "More formatting options", "Quote");
  expect(html).toContain("<blockquote");

  fireEvent.click(within(bar).getByRole("button", { name: "Undo" }));
  expect(html).not.toContain("<blockquote");
  fireEvent.click(within(bar).getByRole("button", { name: "Redo" }));
  expect(html).toContain("<blockquote");

  fireEvent.click(within(bar).getByRole("button", { name: "Bold" }));
  fireEvent.click(within(bar).getByRole("button", { name: "Bulleted list" }));
  expect(html).toContain("<ul>");
});

test("pressing a menu's button again closes it, and Escape closes the colours", () => {
  const bar = setup();
  const font = within(bar).getByRole("button", { name: "Font" });
  fireEvent.click(font);
  expect(font).toHaveAttribute("aria-expanded", "true");
  fireEvent.pointerDown(font);
  fireEvent.click(font);
  expect(screen.queryByRole("menu")).toBeNull();

  fireEvent.click(within(bar).getByRole("button", { name: "Text colour" }));
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Colour" }), { key: "Tab" });
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Colour" }), { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Colour" })).toBeNull();
});

test("the link popover sets, then clears, a link", () => {
  const bar = setup();
  fireEvent.click(within(bar).getByRole("button", { name: "Link" }));
  const field = screen.getByRole("textbox", { name: "Link address" });
  fireEvent.change(field, { target: { value: "https://pheeme.app" } });
  fireEvent.submit(field);
  expect(html).toContain('href="https://pheeme.app"');

  fireEvent.click(within(bar).getByRole("button", { name: "Link" }));
  const again = screen.getByRole("textbox", { name: "Link address" });
  expect(again).toHaveValue("https://pheeme.app");
  fireEvent.change(again, { target: { value: "" } });
  fireEvent.submit(again);
  expect(html).not.toContain("href");

  fireEvent.click(within(bar).getByRole("button", { name: "Link" }));
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Link address" }), { key: "Escape" });
  expect(screen.queryByRole("textbox", { name: "Link address" })).toBeNull();
});

test("a bare domain links to https; a script address isn't taken", () => {
  const bar = setup();
  fireEvent.click(within(bar).getByRole("button", { name: "Link" }));
  const field = screen.getByRole("textbox", { name: "Link address" });
  fireEvent.change(field, { target: { value: "javascript:alert(1)" } });
  fireEvent.submit(field);
  expect(field).toHaveAttribute("aria-invalid", "true");
  expect(html).not.toContain("href");
  fireEvent.change(field, { target: { value: "pheeme.app" } });
  expect(field).not.toHaveAttribute("aria-invalid");
  fireEvent.submit(field);
  expect(html).toContain('href="https://pheeme.app"');
});

test("a link typed with nothing selected goes in as its own text", () => {
  const bar = setup("<p>Hi </p>");
  act(() => void editor().commands.setTextSelection(4));
  fireEvent.click(within(bar).getByRole("button", { name: "Link" }));
  const field = screen.getByRole("textbox", { name: "Link address" });
  fireEvent.change(field, { target: { value: "https://x.test" } });
  fireEvent.submit(field);
  expect(html).toContain(">https://x.test</a>");
});
