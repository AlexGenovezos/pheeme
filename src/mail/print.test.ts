import { expect, test } from "vitest";
import type { MessageDetail, ThreadDetail } from "../lib/tauri";
import { printPage } from "./print";

function message(over: Partial<MessageDetail> = {}): MessageDetail {
  return {
    id: "m1",
    threadId: "t1",
    fromName: "Jonas Weber",
    fromAddress: "jonas@example.net",
    to: [{ name: "Avery", address: "avery@example.com" }],
    cc: [],
    subject: "Plans",
    snippet: "snippet",
    date: Date.UTC(2026, 10, 23, 15, 17),
    bodyHtml: "<p>Lunch <b>Thursday</b>?</p>",
    hasRemoteContent: false,
    declaresDarkMode: false,
    bodyText: null,
    bodyAvailable: true,
    unread: false,
    starred: false,
    labelIds: ["INBOX"],
    hasAttachment: false,
    attachments: [],
    ...over,
  };
}

function thread(messages: MessageDetail[], subject = "Plans"): ThreadDetail {
  return {
    thread: {
      id: "t1",
      accountId: "a1",
      subject,
      snippet: null,
      fromName: null,
      fromAddress: null,
      date: 0,
      unread: false,
      starred: false,
      hasAttachment: false,
      messageCount: messages.length,
      labelIds: [],
      systemLabelIds: [],
    },
    messages,
    bodyError: null,
  };
}

test("the page has the subject, then each message with its people, date, text and files", () => {
  const page = printPage(
    thread([
      message(),
      message({
        id: "m2",
        fromName: null,
        fromAddress: "avery@example.com",
        to: [{ name: null, address: "jonas@example.net" }],
        cc: [{ name: "Mira", address: "mira@example.net" }],
        bodyHtml: null,
        bodyText: "Yes!\n12:30 works.",
        attachments: [
          {
            id: "1",
            filename: "menu.pdf",
            mimeType: "application/pdf",
            size: 2048,
            isInline: false,
            contentId: null,
          },
          {
            id: "2",
            filename: "logo.png",
            mimeType: "image/png",
            size: 10,
            isInline: true,
            contentId: "logo",
          },
        ],
      }),
    ]),
    "avery@example.com",
    "en-US",
  );
  expect(page.title).toBe("Plans");
  expect(page.allowRemote).toBe(true);
  const { html } = page;
  expect(html).toContain("<title>Plans</title>");
  expect(html).toContain('<div class="pheeme-print-account">avery@example.com</div>');
  expect(html).toContain("2 messages");
  expect(html).toContain("<b>Jonas Weber</b> &lt;jonas@example.net&gt;");
  expect(html).toContain("Mon, Nov 23, 2026");
  expect(html).toContain("To: Avery &lt;avery@example.com&gt;");
  // The sanitized body goes in as the reading pane has it.
  expect(html).toContain("<p>Lunch <b>Thursday</b>?</p>");
  expect(html).toContain("<b>avery@example.com</b>");
  expect(html).toContain("Cc: Mira &lt;mira@example.net&gt;");
  expect(html).toContain('<div class="pheeme-print-text">Yes!\n12:30 works.</div>');
  // Files are listed; an inline image is part of the text, not a file.
  expect(html).toContain("1 attachment");
  expect(html).toContain("<li>menu.pdf (2 KB)</li>");
  expect(html).not.toContain("logo.png");
  expect(html.indexOf("Lunch")).toBeLessThan(html.indexOf("Yes!"));
});

test("what the email's sender wrote outside the body is escaped", () => {
  const { html, title } = printPage(
    thread(
      [
        message({
          fromName: '<img src=x onerror="alert(1)">',
          bodyHtml: null,
          bodyText: "<script>alert(1)</script>",
          attachments: [
            {
              id: "1",
              filename: "<b>evil</b>.pdf",
              mimeType: "application/pdf",
              size: null,
              isInline: false,
              contentId: null,
            },
          ],
        }),
      ],
      "</title><script>alert(1)</script>",
    ),
    null,
  );
  expect(title).toBe("</title><script>alert(1)</script>");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img src=x");
  expect(html).not.toContain("<b>evil</b>");
  expect(html).toContain("&lt;/title&gt;&lt;script&gt;");
});

test("a conversation with a message in Spam loads no remote images, as in the reading pane", () => {
  expect(printPage(thread([message({ labelIds: ["SPAM"] })]), null).allowRemote).toBe(false);
});

test("a conversation without a subject prints as (no subject)", () => {
  expect(printPage(thread([message({ subject: null })], ""), null).title).toBe("(no subject)");
});
