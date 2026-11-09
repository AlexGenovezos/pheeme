import { parse } from "culori";
import { themeColorToHex } from "../../styles/themes/color";
import type { ThemeToken } from "../../styles/themes/schema";

/**
 * The editor's inspector (T3 Code's themeInspector, simplified): match what an
 * element paints against the theme's colors, to find which colors it uses, and
 * outline every element that paints a given color. Matching is by rendered
 * value, so two colors set to the same value both match.
 */

const PANEL = "[data-theme-editor]";
const MAX_HIGHLIGHTS = 400;

type Rgba = [number, number, number, number];

/** A color as 0–255 channels (alpha 0–1), or null when it is fully transparent or not a color. */
function normalize(value: string): Rgba | null {
  const color = parse(value);
  if (!color || (color.alpha ?? 1) === 0) return null;
  let hex: string;
  try {
    hex = themeColorToHex(value);
  } catch {
    return null;
  }
  const n = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
  return [n(1), n(3), n(5), hex.length === 9 ? n(7) / 255 : 1];
}

/** The same rendered color, give or take the rounding between the browser's conversion and ours. */
const same = (a: Rgba | null, b: Rgba | null) =>
  a !== null &&
  b !== null &&
  Math.abs(a[0] - b[0]) <= 2 &&
  Math.abs(a[1] - b[1]) <= 2 &&
  Math.abs(a[2] - b[2]) <= 2 &&
  Math.abs(a[3] - b[3]) <= 0.02;

/** Each color token with its value, for matching against computed styles. */
function tokenColors(tokens: Record<ThemeToken, string>): [ThemeToken, Rgba][] {
  return (Object.entries(tokens) as [ThemeToken, string][]).flatMap(([token, value]) => {
    const color = token.startsWith("--color-") ? normalize(value) : null;
    return color ? [[token, color] as [ThemeToken, Rgba]] : [];
  });
}

/** The colors an element paints: its background (or the first painted one behind it), text and border. */
function paintedColors(el: Element): Rgba[] {
  const colors: Rgba[] = [];
  let node: Element | null = el;
  while (node) {
    const bg = normalize(getComputedStyle(node).backgroundColor);
    if (bg) {
      colors.push(bg);
      break;
    }
    node = node.parentElement;
  }
  const style = getComputedStyle(el);
  for (const value of [style.color, style.fill, style.stroke]) {
    const color = normalize(value);
    if (color) colors.push(color);
  }
  if (parseFloat(style.borderTopWidth) > 0 || parseFloat(style.borderBottomWidth) > 0) {
    const border = normalize(style.borderTopColor) ?? normalize(style.borderBottomColor);
    if (border) colors.push(border);
  }
  return colors;
}

/** The theme colors `el` paints, background first. */
export function tokensAt(el: Element, tokens: Record<ThemeToken, string>): ThemeToken[] {
  const all = tokenColors(tokens);
  const found = paintedColors(el).flatMap((painted) =>
    all.filter(([, color]) => same(color, painted)).map(([token]) => token),
  );
  return [...new Set(found)];
}

function overlayBox(rect: DOMRect, className: string): HTMLElement {
  const box = document.createElement("div");
  box.className = className;
  Object.assign(box.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
  return box;
}

/**
 * Outline every element (outside the editor) that paints `value`. Returns a
 * cleanup function; scrolling or resizing clears the outlines, which would no
 * longer line up.
 */
export function highlightUsage(value: string): () => void {
  const wanted = normalize(value);
  const layer = document.createElement("div");
  layer.className = "theme-inspector-layer";
  layer.setAttribute("aria-hidden", "true");
  if (wanted) {
    let count = 0;
    for (const el of document.body.querySelectorAll("*")) {
      if (count >= MAX_HIGHLIGHTS) break;
      if (el.closest(PANEL) || el.closest(".theme-inspector-layer")) continue;
      const style = getComputedStyle(el);
      const paints = [style.backgroundColor, style.color, style.borderTopColor].map(normalize);
      const borderShown = parseFloat(style.borderTopWidth) > 0;
      const [bg, text, border] = paints.map((p) => same(p, wanted));
      if (!bg && !text && !(borderShown && border)) continue;
      // Text color is inherited: outline only where it is set, not on every child.
      if (!bg && el.parentElement && getComputedStyle(el.parentElement).color === style.color)
        continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      layer.append(overlayBox(rect, "theme-inspector-box theme-inspector-box--usage"));
      count++;
    }
  }
  document.body.append(layer);
  const clear = () => {
    layer.remove();
    window.removeEventListener("scroll", clear, true);
    window.removeEventListener("resize", clear);
  };
  window.addEventListener("scroll", clear, true);
  window.addEventListener("resize", clear);
  return clear;
}

/**
 * Pick an element: hovering outlines it, clicking reports it (and is kept from
 * reaching the app), Escape cancels. Returns a function that stops picking.
 */
export function pickElement(onPick: (el: Element) => void, onCancel: () => void): () => void {
  const layer = document.createElement("div");
  layer.className = "theme-inspector-layer";
  layer.setAttribute("aria-hidden", "true");
  document.body.append(layer);
  document.documentElement.dataset.themeInspecting = "";

  const target = (e: Event) => {
    const el = e.target instanceof Element ? e.target : null;
    return el && !el.closest(PANEL) ? el : null;
  };
  const onMove = (e: PointerEvent) => {
    const el = target(e);
    layer.replaceChildren(
      ...(el ? [overlayBox(el.getBoundingClientRect(), "theme-inspector-box")] : []),
    );
  };
  const swallow = (e: Event) => {
    if (!target(e)) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onClick = (e: MouseEvent) => {
    const el = target(e);
    if (!el) return;
    swallow(e);
    stop();
    onPick(el);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    stop();
    onCancel();
  };
  const stop = () => {
    layer.remove();
    delete document.documentElement.dataset.themeInspecting;
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerdown", swallow, true);
    window.removeEventListener("mousedown", swallow, true);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("keydown", onKey, true);
  };
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerdown", swallow, true);
  window.addEventListener("mousedown", swallow, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKey, true);
  return stop;
}
