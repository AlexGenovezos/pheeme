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

  test("leaves out an Outlook reply's quoted original, which follows its marker", () => {
    const html = `<div><p>${prose(90)}</p><div id="appendonsend"></div><hr><div id="divRplyFwdMsg">From: Matt</div><div>${prose(200, 500)}</div></div>`;
    const text = speedReadText(msg({ html }))?.join(" ") ?? "";
    expect(text).toContain("word89");
    expect(text).not.toContain("Matt");
    expect(text).not.toContain("word500");
  });

  test("leaves out signatures, which don't count toward the length either", () => {
    const signature = `<div class="gmail_signature">${prose(60, 900)}</div>`;
    expect(
      speedReadText(msg({ html: `<p>${prose(90)}</p>${signature}` }))?.join(" "),
    ).not.toContain("word900");
    expect(speedReadText(msg({ html: `<p>${prose(40)}</p>${signature}` }))).toBeNull();
  });

  test("leaves out a Yahoo quote, whose class Yahoo prefixes", () => {
    const html = `<div class="ydp253aab85yahoo-style-wrap"><div dir="ltr">${prose(90)}</div></div><div id="ydpc367e72yahoo_quoted_5054539665" class="ydpc367e72yahoo_quoted"><div>On Saturday, Matt wrote:</div><div><div class="ydpc367e72yiv0031642572gmail_default">${prose(200, 500)}</div></div></div>`;
    const text = speedReadText(msg({ html }))?.join(" ") ?? "";
    expect(text).toContain("word89");
    expect(text).not.toContain("word500");
    expect(text).not.toContain("wrote");
  });

  test("leaves out a mailing list's footer", () => {
    const footer = `<p></p>\n\n-- <br>\nYou received this message because you are subscribed to the Google Groups "Board" group.<br>\nTo unsubscribe <a href="mailto:x">board+unsubscribe@example.org</a>.<br>\n`;
    const text = speedReadText(msg({ html: `<div>${prose(90)}</div>${footer}` }))?.join(" ") ?? "";
    expect(text).toContain("word89");
    expect(text).not.toContain("subscribed");
    expect(text).not.toContain("--");
  });

  test("reads a short reply on into the conversation it quotes", () => {
    const footer = `<p></p>\n-- <br>\nYou received this message because you are subscribed.<br>\n`;
    const html = `<div dir="auto">${prose(10)}</div><div><br><div class="gmail_quote gmail_quote_container"><div class="gmail_attr">On Sat, Matt wrote:<br></div><blockquote class="gmail_quote"><div>${prose(90, 500)}</div>${footer}</blockquote></div></div>${footer}`;
    expect(speedReadText(msg({ html }))).toEqual([
      prose(10),
      "On Sat, Matt wrote:",
      prose(90, 500),
    ]);
  });

  test("still skips a short reply when the conversation is short too", () => {
    const html = `<p>Thanks!</p><div class="gmail_quote">On Sat, Matt wrote:<blockquote>Lunch?</blockquote></div>`;
    expect(speedReadText(msg({ html }))).toBeNull();
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
    for (const marker of ["-- ", "--"]) {
      const signed = `${prose(90)}\n${marker}\nMatt Smith\n555 0100`;
      expect(speedReadText(msg({ text: signed }))?.join(" ")).not.toContain("Smith");
    }
  });

  test("stops at an attribution line the mailer wrapped", () => {
    const text = `${prose(90)}\n\nOn Sat, Nov 7, 2026 at 12:16 PM Matt Smith <matt@example.com>\nwrote:\n> old text\n`;
    const read = speedReadText(msg({ text }))?.join(" ") ?? "";
    expect(read).toContain("word89");
    expect(read).not.toContain("Matt");
  });

  test("reads a short reply on into the quoted text, without markers or signatures", () => {
    const text = `${prose(5)}\n\nOn Sat, Matt wrote:\n> ${prose(50, 500)}\n> ${prose(50, 550)}\n> -- \n> Matt Smith\n> 555 0100\n`;
    expect(speedReadText(msg({ text }))).toEqual([
      `${prose(5)}`,
      `On Sat, Matt wrote: ${prose(50, 500)} ${prose(50, 550)}`,
    ]);
  });

  test("prefers the HTML body when there is one", () => {
    const html = `<table><tr><td>${prose(120)}</td></tr></table>`;
    expect(speedReadText(msg({ html, text: prose(120) }))).toBeNull();
  });
});
