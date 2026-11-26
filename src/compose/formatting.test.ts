import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, test } from "vitest";
import {
  align,
  alignmentOf,
  FONTS,
  fontName,
  FORMATTING,
  indent,
  PALETTE,
  QUOTE_STYLE,
  removeFormatting,
} from "./formatting";

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function make(content: string) {
  editor = new Editor({
    extensions: [StarterKit.configure({ heading: false, codeBlock: false }), ...FORMATTING],
    content,
  });
  return editor;
}

/** The editor's HTML without its trailing empty paragraph, styles in one spelling (the DOM's). */
const html = (e: Editor) => norm(e.getHTML().replace(/<p><\/p>$/, ""));
function norm(markup: string) {
  const box = document.createElement("div");
  box.innerHTML = markup;
  box.querySelectorAll<HTMLElement>("[style]").forEach((el) => {
    el.setAttribute("style", el.style.cssText);
  });
  return box.innerHTML;
}

/** Select the whole document's text. */
const selectAll = (e: Editor) =>
  e.commands.setTextSelection({ from: 1, to: e.state.doc.content.size - 1 });

describe("the HTML that goes out is Gmail's", () => {
  test("font, size and text colour are <font> tags, the background a styled span", () => {
    const e = make("<p>Hi</p>");
    selectAll(e);
    e.chain()
      .setMark("fontFace", { face: "georgia, serif" })
      .setMark("fontSize", { size: "4" })
      .setMark("textColor", { color: "#ff0000" })
      .setMark("backgroundColor", { color: "#ffff00" })
      .run();
    expect(html(e)).toBe(
      norm(
        '<p><font face="georgia, serif"><font size="4"><font color="#ff0000"><span style="background-color:#ffff00">Hi</span></font></font></font></p>',
      ),
    );
  });

  test("alignment and indenting are inline styles on the paragraph", () => {
    const e = make("<p>One</p>");
    align(e, "center");
    indent(e, 1);
    indent(e, 1);
    expect(html(e)).toBe(norm('<p style="text-align:center;margin-left:80px">One</p>'));
    expect(alignmentOf(e)).toBe("center");
    indent(e, -1);
    indent(e, -1);
    align(e, "left");
    expect(html(e)).toBe("<p>One</p>");
  });

  test("aligning or indenting an empty line keeps the size chosen for what's typed next", () => {
    const e = make("<p></p>");
    e.commands.setMark("fontSize", { size: "6" });
    align(e, "center");
    indent(e, 1);
    e.commands.insertContent("hello");
    expect(html(e)).toBe(
      norm('<p style="text-align:center;margin-left:40px"><font size="6">hello</font></p>'),
    );
  });

  test("indenting a list item nests it", () => {
    const e = make("<ul><li><p>a</p></li><li><p>b</p></li></ul>");
    e.commands.setTextSelection(8);
    indent(e, 1);
    expect(html(e)).toBe("<ul><li><p>a</p><ul><li><p>b</p></li></ul></li></ul>");
  });

  test("a quote carries Gmail's inline style, never the gmail_quote class", () => {
    const e = make("<p>Quoted</p>");
    e.commands.toggleBlockquote();
    expect(html(e)).toBe(norm(`<blockquote style="${QUOTE_STYLE}"><p>Quoted</p></blockquote>`));
    // `split_quote` (Rust) treats the first gmail_quote element as the start of the quoted original.
    expect(e.getHTML()).not.toContain("gmail_quote");
  });

  test("strikethrough is <s>", () => {
    const e = make("<p>gone</p>");
    selectAll(e);
    e.commands.toggleStrike();
    expect(html(e)).toBe("<p><s>gone</s></p>");
  });
});

describe("a saved draft opens as it was", () => {
  test("Gmail's <font> tags and spans read back into the same marks", () => {
    const saved =
      '<p><font face="verdana, sans-serif"><font size="1"><font color="#0000ff"><span style="background-color:#ffff00">x</span></font></font></font></p>';
    expect(html(make(saved))).toBe(norm(saved));
  });

  test("one <font> carrying face, size and colour becomes all three", () => {
    const e = make('<p><font face="georgia, serif" size="6" color="#cc0000">big</font></p>');
    expect(e.getAttributes("fontFace").face).toBe("georgia, serif");
    expect(e.getAttributes("fontSize").size).toBe("6");
    expect(e.getAttributes("textColor").color).toBe("#cc0000");
  });

  test("alignment and indenting round-trip", () => {
    const saved = '<p style="text-align:right; margin-left:40px">x</p>';
    expect(html(make(saved))).toBe(norm(saved));
  });

  test("a font tag with something odd in it is dropped, its text kept", () => {
    expect(html(make('<p><font size="99" face="a;b{}">x</font></p>'))).toBe("<p>x</p>");
  });
});

test("Remove formatting takes off everything but links", () => {
  const e = make(
    '<p><a href="https://x.test"><b><font color="#ff0000"><font face="monospace">link</font></font></b></a></p>',
  );
  selectAll(e);
  removeFormatting(e);
  expect(html(e)).toBe(
    '<p><a target="_blank" rel="noopener noreferrer nofollow" href="https://x.test">link</a></p>',
  );
});

test("font names", () => {
  expect(fontName(null)).toBe("Sans Serif");
  expect(fontName("Georgia,serif")).toBe("Georgia");
  expect(fontName("Papyrus")).toBe("Papyrus");
  expect(FONTS).toHaveLength(11);
  expect(PALETTE).toHaveLength(64);
  expect(new Set(PALETTE.map((p) => p.name)).size).toBe(64);
});
