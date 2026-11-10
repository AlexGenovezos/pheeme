/**
 * Showing find-in-conversation matches: every match tinted and the current one stronger, through the CSS
 * Custom Highlight API, which paints ranges without touching the DOM (React owns the conversation's
 * nodes). Highlights belong to a document, so each email frame gets its own, with a stylesheet the parent
 * writes into it. Where the API is missing, the current match is selected instead.
 */

const MATCH = "pheeme-find";
const CURRENT = "pheeme-find-current";
const FRAME_STYLE_ID = "pheeme-find-style";

/** Documents holding our highlights (or selection), to clear. */
const painted = new Set<Document>();

type HighlightCtor = new (...ranges: AbstractRange[]) => Highlight;

interface Painter {
  registry: HighlightRegistry;
  Highlight: HighlightCtor;
}

function painterFor(doc: Document): Painter | null {
  // The frame's own realm, so the highlight belongs to the frame's document.
  const view = doc.defaultView as (Window & typeof globalThis) | null;
  const registry = view?.CSS?.highlights;
  const Highlight = (view?.Highlight ?? globalThis.Highlight) as HighlightCtor | undefined;
  return registry && Highlight ? { registry, Highlight } : null;
}

/** `#rrggbb` (or `#rgb`) as 0–1 channels, or null. */
function parseHex(value: string): [number, number, number] | null {
  let hex = value.trim().replace(/^#/, "");
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/**
 * The color that, under a light email's dark-theme filter (`invert(1) hue-rotate(180deg)`, srcdoc.ts),
 * shows as `value`. Both steps are their own inverse, so it is the filter applied to the color.
 */
export function throughFlip(value: string): string {
  const rgb = parseHex(value);
  if (!rgb) return value;
  const [r, g, b] = rgb.map((c) => 1 - c);
  // hue-rotate(180deg) (Filter Effects: cos = -1, sin = 0).
  const out = [
    -0.574 * r + 1.43 * g + 0.144 * b,
    0.426 * r + 0.43 * g + 0.144 * b,
    0.426 * r + 1.43 * g - 0.856 * b,
  ].map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255));
  return `rgb(${out.join(", ")})`;
}

/** The match colors, from the app's tokens (an email frame can't read them). */
function frameCss(doc: Document): string {
  const tokens = getComputedStyle(document.documentElement);
  const flipped =
    doc.defaultView?.getComputedStyle(doc.documentElement).filter.includes("invert") ?? false;
  const color = (name: string) => {
    const value = tokens.getPropertyValue(name).trim();
    return flipped ? throughFlip(value) : value;
  };
  const text = color("--find-match-foreground");
  return [
    `::highlight(${MATCH}) { background-color: ${color("--find-match-bg")}; color: ${text}; }`,
    `::highlight(${CURRENT}) { background-color: ${color("--find-match-current-bg")}; color: ${text}; }`,
  ].join("\n");
}

/** Our stylesheet in an email frame (gone whenever the frame's document is written again). */
function styleFrame(doc: Document) {
  if (doc === document || !doc.head) return;
  const css = frameCss(doc);
  let style = doc.getElementById(FRAME_STYLE_ID);
  if (!style) {
    style = doc.createElement("style");
    style.id = FRAME_STYLE_ID;
    doc.head.append(style);
  }
  if (style.textContent !== css) style.textContent = css;
}

/** Remove every highlight (and fallback selection) find has painted. */
export function clearMatches() {
  for (const doc of painted) {
    const painter = painterFor(doc);
    if (painter) {
      painter.registry.delete(MATCH);
      painter.registry.delete(CURRENT);
    } else {
      doc.getSelection()?.removeAllRanges();
    }
  }
  painted.clear();
}

/** Paint `matches`, `current` (an index into them, or -1) the strong one. */
export function paintMatches(matches: readonly Range[], current: number) {
  clearMatches();
  const byDoc = new Map<Document, Range[]>();
  for (const range of matches) {
    const doc = range.startContainer.ownerDocument;
    if (!doc) continue;
    byDoc.set(doc, [...(byDoc.get(doc) ?? []), range]);
  }
  const currentRange = matches[current];
  const currentDoc = currentRange?.startContainer.ownerDocument;
  if (currentDoc) byDoc.set(currentDoc, byDoc.get(currentDoc) ?? []);

  for (const [doc, ranges] of byDoc) {
    painted.add(doc);
    const painter = painterFor(doc);
    if (!painter) {
      if (doc === currentDoc) {
        const selection = doc.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(currentRange.cloneRange());
      }
      continue;
    }
    styleFrame(doc);
    painter.registry.set(MATCH, new painter.Highlight(...ranges.filter((r) => r !== currentRange)));
    if (doc === currentDoc) {
      const strong = new painter.Highlight(currentRange);
      strong.priority = 1;
      painter.registry.set(CURRENT, strong);
    }
  }
}

/** Where `range` is on screen, in the app window's coordinates (a frame's offset added). */
export function screenRect(range: Range): { top: number; bottom: number } | null {
  if (typeof range.getBoundingClientRect !== "function") return null;
  const r = range.getBoundingClientRect();
  const doc = range.startContainer.ownerDocument;
  const frame = doc && doc !== document ? doc.defaultView?.frameElement : null;
  const offset = frame ? frame.getBoundingClientRect().top + frame.clientTop : 0;
  return { top: r.top + offset, bottom: r.bottom + offset };
}

/**
 * Scroll `range` into view in `pane` (and inside its frame, for a long email that scrolls on its own),
 * leaving it a third of the way down. `topInset` is covered by the find bar, so it counts as out of view.
 */
export function revealMatch(range: Range, pane: HTMLElement, topInset = 0) {
  if (typeof range.getBoundingClientRect !== "function") return;
  const doc = range.startContainer.ownerDocument;
  const view = doc?.defaultView;
  const scroller = doc && doc !== document ? doc.scrollingElement : null;
  if (scroller && view && scroller.scrollHeight > scroller.clientHeight + 1) {
    const r = range.getBoundingClientRect();
    if (r.top < 0 || r.bottom > view.innerHeight)
      scroller.scrollTop += r.top - view.innerHeight / 3;
  }
  const box = screenRect(range);
  if (!box) return;
  const p = pane.getBoundingClientRect();
  if (box.top >= p.top + topInset && box.bottom <= p.bottom) return;
  pane.scrollTop += box.top - (p.top + p.height / 3);
}
