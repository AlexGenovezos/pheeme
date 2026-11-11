import { type RefObject, useEffect, useLayoutEffect, useState } from "react";

/** Live width of an element (0 until measured, or where ResizeObserver is missing). */
export function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/**
 * Live height of an element (0 where ResizeObserver is missing). Measured before the first paint,
 * so what's laid out by it never shows at a guessed size first.
 */
export function useHeight(ref: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    setHeight(el.getBoundingClientRect().height);
    const ro = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return height;
}
