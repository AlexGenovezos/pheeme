import { describe, expect, test } from "vitest";
import type { MessageDetail } from "../lib/tauri";
import { MIN_WORDS, speedReadText } from "./text";

const prose = (words: number, start = 0) =>
  Array.from({ length: words }, (_, i) => `word${start + i}`).join(" ");

function msg(body: { html?: string; text?: string }): MessageDetail {
  return {
    id: "m",
    threadId: "t",
    fromName: null,
    fromAddress: null,
    to: [],
    cc: [],
    subject: "s",
    snippet: null,
    date: 0,
    bodyHtml: body.html ?? null,
    hasRemoteContent: false,
    declaresDarkMode: false,
    bodyText: body.text ?? null,
    bodyAvailable: true,
    unread: false,
    starred: false,
    labelIds: [],
    hasAttachment: false,
    attachments: [],
  };
}

describe("speedReadText: HTML", () => {
  test("reads a letter as its paragraphs", () => {
    const html = `<div><p>Hello <b>Avery</b>,</p><p>${prose(100)}</p><div>Regards,<br>Matt</div></div>`;
    expect(speedReadText(msg({ html }))).toEqual(["Hello Avery,", prose(100), "Regards,", "Matt"]);
  });

  test("skips emails too short to be worth it", () => {
    expect(speedReadText(msg({ html: `<p>${prose(MIN_WORDS - 1)}</p>` }))).toBeNull();
  });

  test("skips layouts: words mostly in table cells", () => {
    const html = `<table><tr><td>${prose(60)}</td><td>${prose(60, 60)}</td></tr></table><p>${prose(20)}</p>`;
    expect(speedReadText(msg({ html }))).toBeNull();
  });

  test("allows a small table, like a signature", () => {
    const html = `<p>${prose(120)}</p><table><tr><td>Matt Smith</td><td>555 0100</td></tr></table>`;
    expect(speedReadText(msg({ html }))).not.toBeNull();
  });

  test("skips image-heavy emails but ignores tracking pixels", () => {
    const body = `<p>${prose(120)}</p>`;
    const pictures = '<img src="a"><img src="b"><img src="c">';
    const pixels = Array.from({ length: 4 }, () => '<img src="p" width="1" height="1">').join("");
    expect(speedReadText(msg({ html: body + pictures }))).toBeNull();
    expect(speedReadText(msg({ html: body + pixels }))).not.toBeNull();
  });

  test("skips link lists", () => {
    const links = Array.from({ length: 30 }, (_, i) => `<a href="#">story number ${i}</a>`).join(
      " ",
    );
    expect(speedReadText(msg({ html: `<p>${prose(100)}</p><p>${links}</p>` }))).toBeNull();
  });

  test("leaves out the quoted original in a reply", () => {
    const html = `<p>${prose(90)}</p><div class="gmail_quote">On Monday Matt wrote:<blockquote>old text</blockquote></div>`;
    const paragraphs = speedReadText(msg({ html }));
    expect(paragraphs?.join(" ")).not.toContain("old text");
    expect(paragraphs?.join(" ")).not.toContain("wrote");
  });

  test("ignores styles and scripts", () => {
    const html = `<style>p { color: red }</style><p>${prose(90)}</p>`;
    expect(speedReadText(msg({ html }))?.join(" ")).not.toContain("color");
  });
});

describe("speedReadText: plain text", () => {
  test("joins wrapped lines and splits on blank lines", () => {
    const text = `Hi Avery,\n\n${prose(50)}\n${prose(50, 50)}\n\nMatt`;
    expect(speedReadText(msg({ text }))).toEqual([
      "Hi Avery,",
      `${prose(50)} ${prose(50, 50)}`,
      "Matt",
    ]);
  });

  test("stops at the signature and at the quoted original", () => {
    const text = `${prose(90)}\n\nOn Mon, Matt wrote:\n> old text\n`;
    expect(speedReadText(msg({ text }))?.join(" ")).not.toContain("old");
    const signed = `${prose(90)}\n-- \nMatt Smith\n555 0100`;
    expect(speedReadText(msg({ text: signed }))?.join(" ")).not.toContain("Smith");
  });

  test("prefers the HTML body when there is one", () => {
    const html = `<table><tr><td>${prose(120)}</td></tr></table>`;
    expect(speedReadText(msg({ html, text: prose(120) }))).toBeNull();
  });
});
