/**
 * Find in conversation (mod+f): the text matching, apart from painting and the bar. It reads what the
 * open conversation shows, in order: its own text and, where an HTML email sits, the text of that email's
 * frame (same-origin, so the parent can walk it). Each match is a DOM Range in the document it was found in.
 */

/** Past this many matches the rest aren't collected (the count shows "1,000+"). */
export const MAX_MATCHES = 1000;

// Numeric so they work on nodes from a frame's realm, where the parent's `NodeFilter` and
// `instanceof Element` don't apply.
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const SHOW_ELEMENT = 0x1;
const SHOW_TEXT = 0x4;
const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;
const FILTER_SKIP = 3;

/** Elements whose text never shows. */
const NOT_SHOWN = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE"]);

/**
 * The query as a pattern: case-insensitive, and any run of whitespace in it matches any run in the text
 * (emails are full of line breaks, runs of spaces and non-breaking spaces). Null for an empty query.
 */
export function queryPattern(query: string): RegExp | null {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(escaped.join("\\s+"), "giu");
}

/** A text node and where its text starts in its chunk's string. */
interface Piece {
  node: Text;
  start: number;
}

/** The text of one document between two frames, with block boundaries as line breaks. */
interface Chunk {
  doc: Document;
  text: string;
  pieces: Piece[];
}

/** An element the user can't see: `display: none`, `visibility: hidden`, `opacity: 0` (preheaders). */
function hidden(el: Element): boolean {
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (typeof el.checkVisibility !== "function")
    return style?.display === "none" || style?.visibility === "hidden" || style?.opacity === "0";
  if (el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
  // `display: contents` has no box of its own, so it reads as invisible while its children show.
  return style?.display !== "contents";
}

/**
 * Collect the text under `root` into chunks. A block boundary (a new paragraph, cell, `<br>`) becomes a
 * line break, so words from two blocks don't run together, and a frame starts a new chunk.
 */
function collect(root: Element, chunks: Chunk[]) {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  const blocks = new Map<Element, Element>();
  /** The nearest ancestor that isn't laid out inline: text in the same one reads as one run. */
  const blockOf = (el: Element): Element => {
    const cached = blocks.get(el);
    if (cached) return cached;
    const display = view?.getComputedStyle(el).display ?? "inline";
    const parent = el.parentElement;
    const block =
      (display === "inline" || display === "contents") && parent && el !== root
        ? blockOf(parent)
        : el;
    blocks.set(el, block);
    return block;
  };

  let chunk: Chunk = { doc, text: "", pieces: [] };
  let lastBlock: Element | null = null;
  const flush = () => {
    if (chunk.pieces.length) chunks.push(chunk);
    chunk = { doc, text: "", pieces: [] };
    lastBlock = null;
  };

  const walker = doc.createTreeWalker(root, SHOW_ELEMENT | SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType !== ELEMENT_NODE) return FILTER_ACCEPT;
      const el = node as Element;
      if (NOT_SHOWN.has(el.nodeName.toUpperCase())) return FILTER_REJECT;
      if (hidden(el)) return FILTER_REJECT;
      return el.nodeName === "IFRAME" || el.nodeName === "BR" ? FILTER_ACCEPT : FILTER_SKIP;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === TEXT_NODE) {
      const text = node as Text;
      if (!text.data || !text.parentElement) continue;
      const block = blockOf(text.parentElement);
      if (chunk.text && block !== lastBlock) chunk.text += "\n";
      lastBlock = block;
      chunk.pieces.push({ node: text, start: chunk.text.length });
      chunk.text += text.data;
    } else if (node.nodeName === "BR") {
      lastBlock = null;
    } else {
      // An email's frame: its text comes in here, in reading order.
      flush();
      let body: HTMLElement | null = null;
      try {
        body = (node as HTMLIFrameElement).contentDocument?.body ?? null;
      } catch {
        body = null; // cross-origin: not ours to read
      }
      if (body) collect(body, chunks);
    }
  }
  flush();
}

/** The text node and offset at `index` in `chunk`. `end` places an index between two nodes in the first. */
function locate(chunk: Chunk, index: number, end: boolean): [Text, number] {
  const { pieces } = chunk;
  let lo = 0;
  let hi = pieces.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const start = pieces[mid].start;
    if (end ? start < index : start <= index) lo = mid;
    else hi = mid - 1;
  }
  const piece = pieces[lo];
  return [piece.node, Math.min(index - piece.start, piece.node.length)];
}

export interface FindResult {
  matches: Range[];
  /** Stopped at MAX_MATCHES: there are more. */
  capped: boolean;
}

/** Every match for `query` in what `root` shows, in reading order. */
export function findMatches(root: Element, query: string, max = MAX_MATCHES): FindResult {
  const pattern = queryPattern(query);
  if (!pattern) return { matches: [], capped: false };
  const chunks: Chunk[] = [];
  collect(root, chunks);
  const matches: Range[] = [];
  for (const chunk of chunks) {
    pattern.lastIndex = 0;
    for (const m of chunk.text.matchAll(pattern)) {
      if (matches.length === max) return { matches, capped: true };
      const range = chunk.doc.createRange();
      range.setStart(...locate(chunk, m.index, false));
      range.setEnd(...locate(chunk, m.index + m[0].length, true));
      matches.push(range);
    }
  }
  return { matches, capped: false };
}

/**
 * A match whose text has since gone (the conversation re-rendered, a frame was rewritten). Ranges are live:
 * removing their text collapses them onto the parent, so a match left empty is one that went.
 */
export const isStale = (range: Range) => range.collapsed || !range.startContainer.isConnected;
