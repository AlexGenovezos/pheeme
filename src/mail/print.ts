// Print, as Gmail does it: the open conversation as a plain page (the subject, then each message with who it's
// from and to, when, its text and its files) in a window of its own, with the system's print dialog over it.
// Rust shows the page under a policy that runs no script (`src-tauri/src/print.rs`).
import { toast, toastError } from "../components/ui/Toast";
import { type EmailAddress, type MessageDetail, printEmail, type ThreadDetail } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { useThreadStore } from "../store/threadStore";
import { useUiStore } from "../store/uiStore";
import { formatSize } from "./AttachmentList";
import { isCalendarBodyPart } from "./invitePart";
import { parseThreadKey } from "./mailboxes";

export const PRINT_COMMAND = "conversation.print";

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const person = (name: string | null | undefined, address: string | null | undefined) => {
  const shown = name?.trim();
  if (shown && address) return `<b>${escape(shown)}</b> &lt;${escape(address)}&gt;`;
  return `<b>${escape(shown || address || "Unknown sender")}</b>`;
};

const people = (list: EmailAddress[]) =>
  list.map((a) => (a.name?.trim() ? `${a.name.trim()} <${a.address}>` : a.address)).join(", ");

/** "Mon, Nov 23, 2026, 3:17 PM", with the year (a printout outlives the week). */
const when = (ms: number, locale?: string) =>
  new Date(ms).toLocaleString(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** What each message body's own styles start from inside its shadow root. */
const BODY_STYLE =
  "<style>:host { display: block; } img { max-width: 100%; height: auto; }</style>";

/**
 * The message's text: its sanitized HTML as the reading pane shows it, else its plain text, else its preview. HTML
 * goes in a declarative shadow root (no script needed), so the email's own stylesheets apply only inside it; the
 * host's containment keeps positioned content from leaving the box.
 */
function body(m: MessageDetail): string {
  if (m.bodyHtml)
    return `<div class="pheeme-print-body"><template shadowrootmode="open">${BODY_STYLE}${m.bodyHtml}</template></div>`;
  const text = m.bodyText ?? m.snippet ?? "";
  return `<div class="pheeme-print-body"><div class="pheeme-print-text">${escape(text)}</div></div>`;
}

function message(m: MessageDetail, locale?: string): string {
  const files = m.attachments.filter((a) => !a.isInline && !isCalendarBodyPart(a));
  const lines = [
    `<div class="pheeme-print-from"><span>${person(m.fromName, m.fromAddress)}</span>`,
    m.date > 0 ? `<span class="pheeme-print-date">${escape(when(m.date, locale))}</span>` : "",
    `</div>`,
    m.to.length > 0 ? `<div class="pheeme-print-to">To: ${escape(people(m.to))}</div>` : "",
    m.cc.length > 0 ? `<div class="pheeme-print-to">Cc: ${escape(people(m.cc))}</div>` : "",
    body(m),
  ];
  if (files.length > 0) {
    const names = files.map((a) => {
      const size = a.size != null ? ` (${formatSize(a.size)})` : "";
      return `<li>${escape(a.filename || "Untitled")}${escape(size)}</li>`;
    });
    lines.push(
      `<div class="pheeme-print-files">${files.length === 1 ? "1 attachment" : `${files.length} attachments`}`,
      `<ul>${names.join("")}</ul></div>`,
    );
  }
  return `<section class="pheeme-print-message">${lines.filter(Boolean).join("\n")}</section>`;
}

/** Ours, ahead of the emails' own styles, which come later and win only inside their bodies. */
const STYLE = `
:root { color-scheme: light; }
body { margin: 24px; color: #000; background: #fff; font: 13px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
.pheeme-print-account { color: #555; border-bottom: 2px solid #000; padding-bottom: 6px; }
.pheeme-print-subject { font-size: 20px; margin: 16px 0 2px; }
.pheeme-print-count { color: #555; margin-bottom: 8px; }
.pheeme-print-message { border-top: 1px solid #bbb; padding: 12px 0; }
.pheeme-print-from { display: flex; justify-content: space-between; gap: 16px; }
.pheeme-print-date, .pheeme-print-to { color: #555; }
.pheeme-print-body { margin-top: 12px; overflow-wrap: break-word; position: relative; contain: layout paint; }
.pheeme-print-text { white-space: pre-wrap; }
.pheeme-print-files { margin-top: 12px; border-top: 1px dashed #bbb; padding-top: 6px; color: #555; }
.pheeme-print-files ul { margin: 4px 0 0; padding-left: 20px; }
@media print { body { margin: 0; } .pheeme-print-message { break-inside: auto; } }
`;

/**
 * The page for `detail`: title (the subject), the whole HTML document, and whether it may load remote images (not
 * when any message is in Spam, as in the reading pane until Show images).
 */
export function printPage(
  detail: ThreadDetail,
  account: string | null,
  locale?: string,
): { title: string; html: string; allowRemote: boolean } {
  const subject = detail.thread.subject?.trim() || detail.messages[0]?.subject?.trim() || "";
  const title = subject || "(no subject)";
  const count = detail.messages.length;
  const html = [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${escape(title)}</title>`,
    `<style>${STYLE}</style>`,
    "</head><body>",
    account ? `<div class="pheeme-print-account">${escape(account)}</div>` : "",
    `<h1 class="pheeme-print-subject">${escape(title)}</h1>`,
    `<div class="pheeme-print-count">${count === 1 ? "1 message" : `${count} messages`}</div>`,
    ...detail.messages.map((m) => message(m, locale)),
    "</body></html>",
  ];
  return {
    title,
    html: html.filter(Boolean).join("\n"),
    allowRemote: !detail.messages.some((m) => m.labelIds.includes("SPAM")),
  };
}

/** Print the open conversation (all of it, as Gmail's Print all does). */
export async function printConversation() {
  const key = useUiStore.getState().openThread;
  if (!key) {
    toast({ title: "Open a conversation to print it." });
    return;
  }
  // Fetches what isn't cached, including bodies a cached conversation is still missing.
  await useThreadStore.getState().load(key);
  const detail = useThreadStore.getState().details.get(key);
  if (!detail || detail.messages.length === 0) {
    toast({ title: "That conversation couldn't be loaded to print.", tone: "danger" });
    return;
  }
  if (detail.messages.some((m) => !m.bodyAvailable))
    toast({
      title: "Some messages print as previews",
      description:
        detail.bodyError?.message ?? "Their full text isn't downloaded. Try again when online.",
    });
  const accountId = parseThreadKey(key)?.accountId;
  const account =
    useAccountStore.getState().accounts.find((a) => a.id === accountId)?.email ?? null;
  const page = printPage(detail, account);
  try {
    await printEmail(page.title, page.html, page.allowRemote);
  } catch (e) {
    toastError(e);
  }
}
