// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NOTES_DIR } from "./release.mjs";
import { parseNotes } from "./release-notes.mjs";

const text = (t) => ({ type: "text", text: t });

describe("parseNotes", () => {
  it("reads leads, headings, bullets and inline formatting", () => {
    const notes = [
      "<!-- guide",
      "     over lines -->",
      "",
      "You can write mail now,",
      "with drafts.",
      "",
      "**Compose**",
      "- Press `c` for **New message**.",
      "- See [the site](https://pheeme.app/changelog).",
      "",
      "**Heads-up**",
      "- Keep auto-update on.",
    ].join("\n");
    expect(parseNotes(notes)).toEqual({
      errors: [],
      blocks: [
        {
          type: "paragraph",
          content: [text("You can write mail now,"), text(" "), text("with drafts.")],
        },
        { type: "heading", text: "Compose" },
        {
          type: "list",
          items: [
            [
              text("Press "),
              { type: "code", text: "c" },
              text(" for "),
              { type: "bold", text: "New message" },
              text("."),
            ],
            [
              text("See "),
              { type: "link", text: "the site", href: "https://pheeme.app/changelog" },
              text("."),
            ],
          ],
        },
        { type: "heading", text: "Heads-up" },
        { type: "list", items: [[text("Keep auto-update on.")]] },
      ],
    });
  });

  it("keeps code spans literal", () => {
    const { blocks, errors } = parseNotes("- Updates `0005_add_x.sql` with `*`.\n");
    expect(errors).toEqual([]);
    expect(blocks[0]).toMatchObject({
      items: [
        [text("Updates "), { text: "0005_add_x.sql" }, text(" with "), { text: "*" }, text(".")],
      ],
    });
  });

  it.each([
    ["# Title", "line 1: a # heading (use a line of **bold** text)"],
    ["* item", "line 1: a * or + bullet (use -)"],
    ["1. item", "line 1: a numbered list"],
    ["- a\n  - nested", "line 2: an indented line (nested lists and code blocks aren't supported)"],
    ["- a\ncontinued", "line 2: a bullet continued on the next line (keep each on one line)"],
    ["> quote", "line 1: a quote"],
    ["| a | b |", "line 1: a table"],
    ["```\ncode", "line 1: a code block"],
    ["Some *italics*.", "line 1: a stray * (only **bold** is supported)"],
    ["Some _italics_.", "line 1: _italics_ (only **bold** is supported)"],
    ["A <b>tag</b>.", "line 1: HTML"],
    ["![shot](https://pheeme.app/a.png)", "line 1: an image"],
    [
      "[x](https://example.com)",
      "line 1: link to https://example.com (only https github.com or pheeme.app)",
    ],
    [
      "[x](http://pheeme.app)",
      "line 1: link to http://pheeme.app (only https github.com or pheeme.app)",
    ],
    ["<!-- a\nb -->\n## Late", "line 3: a # heading (use a line of **bold** text)"],
  ])("rejects %j", (notes, error) => {
    expect(parseNotes(notes).errors).toEqual([error]);
  });
});

describe("the notes in the repo", () => {
  const dir = path.resolve(import.meta.dirname, "..", NOTES_DIR);
  const files = fs.readdirSync(dir).filter((f) => /^v\d+\.\d+\.md$/.test(f));
  it.each(files)("%s is in the format the app shows", (file) => {
    expect(parseNotes(fs.readFileSync(path.join(dir, file), "utf8")).errors).toEqual([]);
  });
});
