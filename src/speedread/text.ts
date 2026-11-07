import type { MessageDetail } from "../lib/tauri";

/**
 * Which emails the speed reader offers itself for, and the text it reads from them.
 *
 * It suits a letter, not a layout: prose someone wrote, long enough to be worth it. Newsletters, receipts
 * and notifications put their words in tables, images and links, so an email is skipped when too much of
 * it lives there. Quoted replies are dropped so a reply reads only what's new, unless what's new is too short
 * to bother with: then the reader starts at the new text and carries on into the quoted conversation.
 */

/** Fewer words than this reads faster normally. */
export const MIN_WORDS = 80;
/** Pictures beyond a logo or two (tracking pixels don't count) mean the email is a layout. */
const MAX_IMAGES = 2;
/** Share of the words that may sit in table cells (a signature, a small table) or in link text. */
const MAX_TABLE_SHARE = 0.3;
const MAX_LINK_SHARE = 0.2;

const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);
const SKIP = new Set(["head", "script", "style", "template", "title", "noscript"]);
/**
 * Quoted earlier messages in replies (Gmail, Apple Mail, Yahoo). Classes are matched anywhere in the attribute:
 * Yahoo prefixes its own (`ydpc367e72yahoo_quoted`) and the Gmail classes inside messages it quotes.
 */
const QUOTES =
  'blockquote, [class*="gmail_quote"], [class*="gmail_attr"], [type="cite"], [class*="yahoo_quoted"]';
/** Signatures: never what someone wrote to you, quoted or not. */
const SIGNATURES = '[class*="gmail_signature"], .moz-signature';
/** Outlook marks only where the quoted original starts; everything after the marker is the original. */
const OUTLOOK_QUOTE_START = "#divRplyFwdMsg, #appendonsend";

/** Remove `el` and everything after it in the document. */
function cutFrom(el: Element, body: HTMLElement) {
  for (let node: Element | null = el; node && node !== body; node = node.parentElement) {
    while (node.nextSibling) node.nextSibling.remove();
  }
  el.remove();
}

const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Paragraphs of text in reading order: one per block of the document. */
function paragraphsOf(root: Node): string[] {
  const lines: string[] = [""];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      lines[lines.length - 1] += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = (node as Element).localName;
    if (SKIP.has(tag)) return;
    const block = BLOCK.has(tag);
    if (block) lines.push("");
    node.childNodes.forEach(walk);
    if (block) lines.push("");
  };
  walk(root);
  return lines.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/**
 * A "-- " line starts a signature, which runs to the end of its block. Mailing lists (Google Groups) append
 * their footer this way, once more at every level of a quoted conversation.
 */
function removeDashSignatures(body: HTMLElement) {
  const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const starts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const next = text.nextSibling;
    if (
      /(^|\n)[ \t]*--[ \t]*$/.test(text.data) &&
      next instanceof Element &&
      next.localName === "br"
    ) {
      starts.push(text);
    }
  }
  for (const text of starts) {
    while (text.nextSibling) text.nextSibling.remove();
    text.data = text.data.replace(/[ \t]*--[ \t]*$/, "");
  }
}

function fromHtml(html: string, keepQuotes: boolean): string[] | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  if (!keepQuotes) {
    const outlook = body.querySelector(OUTLOOK_QUOTE_START);
    if (outlook) cutFrom(outlook, body);
    body.querySelectorAll(QUOTES).forEach((q) => q.remove());
  }
  body.querySelectorAll(SIGNATURES).forEach((s) => s.remove());
  removeDashSignatures(body);

  const images = [...body.querySelectorAll("img")].filter((img) => {
    const w = Number(img.getAttribute("width"));
    const h = Number(img.getAttribute("height"));
    return !((w > 0 && w <= 2) || (h > 0 && h <= 2));
  });
  if (images.length > MAX_IMAGES) return null;

  const paragraphs = paragraphsOf(body);
  const total = paragraphs.reduce((n, p) => n + countWords(p), 0);
  if (total < MIN_WORDS) return null;
  // Nested tables would count twice, so measure only the outermost cells.
  const cellWords = [...body.querySelectorAll("td, th")]
    .filter((cell) => !cell.parentElement?.closest("td, th"))
    .reduce((n, cell) => n + countWords(cell.textContent ?? ""), 0);
  if (cellWords / total > MAX_TABLE_SHARE) return null;
  const linkWords = [...body.querySelectorAll("a")].reduce(
    (n, a) => n + countWords(a.textContent ?? ""),
    0,
  );
  if (linkWords / total > MAX_LINK_SHARE) return null;
  return paragraphs;
}

const isSignatureLine = (line: string) => /^--\s*$/.test(line);
/** "On Mon, 3 Nov 2026, Matt <matt@example.com> wrote:", which mailers often wrap onto a second line. */
const startsAttribution = (lines: string[], i: number) =>
  /^On .+wrote:\s*$/.test(lines[i]) ||
  (/^On .+/.test(lines[i]) && /wrote:\s*$/.test(lines[i + 1] ?? ""));

function fromPlainText(text: string, keepQuotes: boolean): string[] | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  // With the quotes: "> " markers come off, and each signature is skipped until its quoted message ends.
  let signatureDepth = -1;
  for (let i = 0; i < lines.length; i++) {
    const marker = /^(?:[ \t]*>)*[ \t]?/.exec(lines[i])![0];
    const depth = marker.split(">").length - 1;
    const line = lines[i].slice(marker.length);
    if (!keepQuotes) {
      // A signature starts at "-- "; the quoted original at its "On …, … wrote:" line or the first "> ".
      if (isSignatureLine(line) || depth > 0 || startsAttribution(lines, i)) break;
    } else if (signatureDepth >= 0 && depth === signatureDepth && !startsAttribution(lines, i)) {
      continue;
    } else if (isSignatureLine(line)) {
      signatureDepth = depth;
      continue;
    } else {
      signatureDepth = -1;
    }
    kept.push(line);
  }
  // Blank lines separate paragraphs; single line breaks are just where the sender's mailer wrapped.
  const paragraphs = kept
    .join("\n")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const total = paragraphs.reduce((n, p) => n + countWords(p), 0);
  return total < MIN_WORDS ? null : paragraphs;
}

const cache = new WeakMap<MessageDetail, string[] | null>();

/**
 * The paragraphs to speed read, or null when the email isn't simple prose or is too short to bother with, even
 * counting the conversation it quotes.
 */
export function speedReadText(message: MessageDetail): string[] | null {
  if (cache.has(message)) return cache.get(message)!;
  let result: string[] | null = null;
  if (message.bodyHtml)
    result = fromHtml(message.bodyHtml, false) ?? fromHtml(message.bodyHtml, true);
  else if (message.bodyText) {
    result = fromPlainText(message.bodyText, false) ?? fromPlainText(message.bodyText, true);
  }
  cache.set(message, result);
  return result;
}
