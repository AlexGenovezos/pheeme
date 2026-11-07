import type { MessageDetail } from "../lib/tauri";

/**
 * Which emails the speed reader offers itself for, and the text it reads from them.
 *
 * It suits a letter, not a layout: prose someone wrote, long enough to be worth it. Newsletters, receipts
 * and notifications put their words in tables, images and links, so an email is skipped when too much of
 * it lives there. Quoted replies are dropped so a reply reads only what's new.
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
/** Quoted earlier messages in replies: Gmail, Apple Mail, Outlook, Yahoo. */
const QUOTES =
  'blockquote, .gmail_quote, .gmail_attr, [type="cite"], #divRplyFwdMsg, #appendonsend, .yahoo_quoted';

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

function fromHtml(html: string): string[] | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  body.querySelectorAll(QUOTES).forEach((q) => q.remove());

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

function fromPlainText(text: string): string[] | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  // A signature starts at "-- "; the quoted original at its "On …, … wrote:" line or the first "> ".
  const kept: string[] = [];
  for (const line of lines) {
    if (line === "-- " || line.startsWith(">")) break;
    if (/^On .+wrote:\s*$/.test(line)) break;
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

/** The paragraphs to speed read, or null when the email isn't simple prose (or is too short to bother). */
export function speedReadText(message: MessageDetail): string[] | null {
  if (cache.has(message)) return cache.get(message)!;
  let result: string[] | null = null;
  if (message.bodyHtml) result = fromHtml(message.bodyHtml);
  else if (message.bodyText) result = fromPlainText(message.bodyText);
  cache.set(message, result);
  return result;
}
