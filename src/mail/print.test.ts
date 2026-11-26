import { mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, expect, test } from "vitest";
import { dismissToast, useToastStore } from "../components/ui/Toast";
import type { MessageDetail, ThreadDetail } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { useThreadStore } from "../store/threadStore";
import { useUiStore } from "../store/uiStore";
import { printMessage, printOpenConversation, printPage } from "./print";
import { usePrintSettings } from "./printSettings";

afterEach(() => {
  useToastStore.getState().toasts.forEach((t) => dismissToast(t.id));
  useUiStore.setState({ openThread: null });
  useThreadStore.setState({ details: new Map() });
  useAccountStore.setState({ accounts: [] });
  usePrintSettings.setState({ scope: "conversation" });
});

const toastTitles = () => useToastStore.getState().toasts.map((t) => t.title);

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
    unsubscribe: "none",
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
  // The sanitized body goes in as the reading pane has it, in a shadow root of its own so its styles stay in it.
  expect(html).toMatch(
    /<div class="pheeme-print-body"><div><template shadowrootmode="open"><style>[^<]*<\/style><p>Lunch <b>Thursday<\/b>\?<\/p><\/template><\/div><\/div>/,
  );
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

test("Print sends the open conversation's page to a print window", async () => {
  const printed: Array<Record<string, unknown>> = [];
  mockIPC((cmd, args) => {
    if (cmd === "print_email") printed.push(args as Record<string, unknown>);
    return undefined;
  });
  useAccountStore.setState({
    accounts: [
      {
        id: "a1",
        email: "avery@example.com",
        displayName: null,
        clientId: "c",
        synced: true,
        color: 1,
      },
    ],
  });
  useThreadStore.setState({ details: new Map([["a1:t1", thread([message()])]]) });
  useUiStore.setState({ openThread: "a1:t1" });

  await printOpenConversation();
  expect(printed).toHaveLength(1);
  expect(printed[0].title).toBe("Plans");
  expect(printed[0].allowRemote).toBe(true);
  expect(String(printed[0].html)).toContain(
    '<div class="pheeme-print-account">avery@example.com</div>',
  );
  expect(toastTitles()).toEqual([]);
});

test("Print says so when nothing is open, and when a message prints as a preview", async () => {
  const printed: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "print_email") printed.push(args);
    // A body that still can't be fetched.
    if (cmd === "get_thread") return thread([message({ bodyAvailable: false, bodyHtml: null })]);
    return undefined;
  });
  await printOpenConversation();
  expect(toastTitles()).toEqual(["Open a conversation to print it."]);
  expect(printed).toEqual([]);

  useUiStore.setState({ openThread: "a1:t1" });
  await printOpenConversation();
  expect(printed).toHaveLength(1);
  expect(toastTitles()).toContain("It prints as a preview");
});

const twoAndADraft = () =>
  thread([
    message({ id: "m1", bodyHtml: "<p>first</p>" }),
    message({ id: "m2", bodyHtml: "<p>second</p>", labelIds: ["SPAM"] }),
    message({ id: "m3", bodyHtml: "<p>a draft</p>", labelIds: ["DRAFT"] }),
  ]);

test("a page of one message has only that message, and says it is one of the conversation's", () => {
  const page = printPage(twoAndADraft(), null, undefined, "m1");
  expect(page.html).toContain("<p>first</p>");
  expect(page.html).not.toContain("<p>second</p>");
  expect(page.html).not.toContain("<p>a draft</p>");
  expect(page.html).toContain('<div class="pheeme-print-count">1 of 3 messages</div>');
  // Another message being in Spam doesn't hold back this one's images.
  expect(page.allowRemote).toBe(true);
  expect(printPage(twoAndADraft(), null).html).toContain(
    '<div class="pheeme-print-count">3 messages</div>',
  );
});

/** What each print_email call printed, with get_thread answering `detail`. */
function capturePrints(detail: ThreadDetail) {
  const printed: string[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "get_thread") return detail;
    if (cmd === "print_email") printed.push(String((args as { html: string }).html));
    return undefined;
  });
  useThreadStore.setState({ details: new Map([["a1:t1", detail]]) });
  return printed;
}

test("with Latest message chosen, Print prints only the message Reply answers", async () => {
  const printed = capturePrints(twoAndADraft());
  useUiStore.setState({ openThread: "a1:t1" });
  usePrintSettings.setState({ scope: "message" });

  await printOpenConversation();
  expect(printed).toHaveLength(1);
  expect(printed[0]).toContain("<p>second</p>");
  expect(printed[0]).not.toContain("<p>first</p>");
  expect(printed[0]).not.toContain("<p>a draft</p>");

  usePrintSettings.setState({ scope: "conversation" });
  await printOpenConversation();
  expect(printed[1]).toContain("<p>first</p>");
  expect(printed[1]).toContain("<p>a draft</p>");
});

test("a message's printer button prints that message alone, whatever the setting", async () => {
  const printed = capturePrints(twoAndADraft());
  await printMessage("a1:t1", "m1");
  expect(printed).toHaveLength(1);
  expect(printed[0]).toContain("<p>first</p>");
  expect(printed[0]).not.toContain("<p>second</p>");
});
